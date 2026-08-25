import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import crypto from 'node:crypto';
import { Op } from 'sequelize';
import { VettingBid } from '../models/VettingBid.js';
import { VettingOpeningAttestation } from '../models/VettingOpeningAttestation.js';
import { VettingDecidedRecord } from '../models/VettingDecidedRecord.js';
import { Organization } from '../models/Organization.js';
import { TenderInvitation } from '../models/TenderInvitation.js';
import { Payment } from '../models/Payment.js';
import { TenderDocumentField } from '../models/TenderDocumentField.js';
import { TenderDocumentUpload } from '../models/TenderDocumentUpload.js';
import { EmdSubmission } from '../models/EmdSubmission.js';
import { reconstructPrivateKey, openEnvelope, type SealedEnvelope } from '../lib/vettingCrypto.js';
import { encryptField } from '../lib/fieldEncryption.js';
import { verifyOrgToken } from '../lib/orgAuth.js';
import { logger } from '../lib/logger.js';

const router = Router();

// Same max-length reasoning as auctionAdmin.ts's seed schema — an unbounded field only fails at
// the DB insert as a raw truncation error instead of a clean 400.
const MAX_STRING_FIELD_LENGTH = 255;
// Ciphertext/wrapped-key fields are base64 of RSA-3072/AES-256-GCM output — generous bound well
// above what those ever actually produce, just to reject obviously-wrong input early.
const MAX_ENVELOPE_FIELD_LENGTH = 8192;

const envelopeSchema = z.object({
  wrappedDataKey: z.string().min(1).max(MAX_ENVELOPE_FIELD_LENGTH),
  iv: z.string().min(1).max(MAX_ENVELOPE_FIELD_LENGTH),
  ciphertext: z.string().min(1).max(MAX_ENVELOPE_FIELD_LENGTH),
});

// applicantAlias is deliberately NOT client-supplied any more — it's derived from the authenticated
// generator's own org record below, so a submission can never claim to be a different generator
// than the one that actually holds the token. See tenders.ts's invitation-gating for the other half
// of this: a submission also requires an accepted TenderInvitation for this org + tenderRef.
const submitBodySchema = z.object({
  tenderRef: z.string().trim().min(1, 'tenderRef is required').max(MAX_STRING_FIELD_LENGTH),
  technical: envelopeSchema,
  financial: envelopeSchema,
});

const shareArraySchema = z.array(z.string().min(1)).length(2, 'exactly two custodian shares are required');

const openTechnicalBodySchema = z.object({
  tenderRef: z.string().trim().min(1).max(MAX_STRING_FIELD_LENGTH),
  shares: shareArraySchema,
  isEmergency: z.boolean().optional().default(false),
  emergencyJustification: z.string().trim().max(2000).optional(),
});

const technicalDecisionBodySchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  // The evaluator's confirmed copy of what the ceremony revealed for this submission — the server
  // never re-derives this itself (that would mean re-running a ceremony), it durably records what
  // was legitimately reviewed. See VETTING_BID_SEALING_IMPLEMENTATION_PLAN.md's "Post-decision
  // durable storage" section for why this is a deliberately different mechanism from the
  // custodian scheme, not a weaker version of it.
  reviewedContent: z.string().min(1).max(MAX_ENVELOPE_FIELD_LENGTH * 4),
});

const openFinancialBodySchema = z.object({
  tenderRef: z.string().trim().min(1).max(MAX_STRING_FIELD_LENGTH),
  shares: shareArraySchema,
});

// Submission now requires a real generator org token + accepted invitation (see the route below).
// The ceremony/decision/public-keys/list routes remain unauthenticated, matching this codebase's
// existing pattern for admin-operated routes — rate limiting is the cheap bound in the meantime.
// The one exception, per AUTH_STRATEGY_DECISIONS.md: /decided-record specifically is planned for
// email+password auth before real data ever flows through it, since it holds settled bid/KYC
// content — not built in this pass, flagged here so it isn't mistaken for an oversight.
const submitLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
// Ceremonies are inherently rare, manual actions — this limit exists only to bound scripted abuse,
// not to constrain legitimate use, so it's generous (matches auctionAdmin.ts's exportLimiter).
const ceremonyLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const readLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

function getTechnicalKeyConfig() {
  const publicKeyPem = process.env.VETTING_TECHNICAL_PUBLIC_KEY_PEM;
  const fingerprint = process.env.VETTING_TECHNICAL_PUBLIC_KEY_FINGERPRINT;
  if (!publicKeyPem || !fingerprint) throw new Error('VETTING_TECHNICAL_PUBLIC_KEY_PEM / VETTING_TECHNICAL_PUBLIC_KEY_FINGERPRINT not configured');
  return { publicKeyPem, fingerprint };
}

function getFinancialKeyConfig() {
  const publicKeyPem = process.env.VETTING_FINANCIAL_PUBLIC_KEY_PEM;
  const fingerprint = process.env.VETTING_FINANCIAL_PUBLIC_KEY_FINGERPRINT;
  if (!publicKeyPem || !fingerprint) throw new Error('VETTING_FINANCIAL_PUBLIC_KEY_PEM / VETTING_FINANCIAL_PUBLIC_KEY_FINGERPRINT not configured');
  return { publicKeyPem, fingerprint };
}

function decodeShares(shares: string[]): Uint8Array[] {
  return shares.map((s) => new Uint8Array(Buffer.from(s, 'base64')));
}

function extractBearerToken(authHeader: string | undefined): string | undefined {
  return authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
}

function hashOpenedSet(ids: number[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(ids.sort((a, b) => a - b))).digest('hex');
}

// Submission — seals both envelopes client-side before this is ever called; this route only
// stores opaque ciphertext, never plaintext, for either envelope. Also gated on invitation: a
// generator must hold a valid token AND an 'accepted' TenderInvitation for this tenderRef, closing
// the gap where any caller could submit a bid against any tenderRef under a made-up name.
router.post('/vetting-bids', submitLimiter, async (req, res, next) => {
  try {
    const parsed = submitBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }
    const { tenderRef, technical, financial } = parsed.data;

    const token = extractBearerToken(req.headers.authorization);
    if (!token) return res.status(401).json({ success: false, error: 'Missing organization token' });
    let orgPayload;
    try {
      orgPayload = await verifyOrgToken(token);
    } catch {
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
    if (orgPayload.type !== 'generator') {
      return res.status(403).json({ success: false, error: 'Only generator organizations submit bids' });
    }

    const generatorOrg = await Organization.findByPk(orgPayload.organizationId);
    if (!generatorOrg) return res.status(401).json({ success: false, error: 'Unknown organization' });

    const tenderId = Number(tenderRef);
    if (!Number.isFinite(tenderId)) {
      return res.status(400).json({ success: false, error: 'tenderRef must be a real tender id' });
    }
    const invitation = await TenderInvitation.findOne({
      where: { tenderId, organizationId: generatorOrg.id, status: 'accepted' },
    });
    if (!invitation) {
      return res.status(403).json({ success: false, error: 'You must accept this tender\'s invitation before submitting a bid' });
    }

    // Payment gate (TENDER_WORKFLOW_STAKEHOLDER_PLAN.md Stage 6): the Bid Processing Fee is due
    // BEFORE final submission, not after. e-KYC (also in that Stage 6 sequence) has no gate here
    // yet — it's still blocked on a vendor decision, flagged elsewhere, not silently skipped.
    const bidProcessingPayment = await Payment.findOne({
      where: { tenderId, organizationId: generatorOrg.id, purpose: 'bid_processing', status: 'paid' },
    });
    if (!bidProcessingPayment) {
      return res.status(402).json({
        success: false,
        error: 'The following fees must be paid before submitting a bid: Bid Processing Fee',
        missingFees: ['Bid Processing Fee'],
      });
    }

    // EMD gate — a document requirement, not a payment (see EmdSubmission's own comment): the
    // generator must have already submitted its Bank Guarantee before a bid can be accepted.
    const emdSubmission = await EmdSubmission.findOne({ where: { tenderId, organizationId: generatorOrg.id } });
    if (!emdSubmission) {
      return res.status(400).json({
        success: false,
        error: 'You must submit your EMD Bank Guarantee before submitting a bid',
      });
    }

    // Document checklist gate (Stage 6.1/6.2/6.3): every REQUIRED field in this tender's document
    // registry must have this generator's upload on file before the sealed bid itself is accepted
    // — the checklist and the bid are one submission conceptually, even though uploads happen via
    // a separate route (tenderDocuments.ts) ahead of this call.
    const requiredFields = await TenderDocumentField.findAll({ where: { tenderId, required: true } });
    if (requiredFields.length > 0) {
      const uploads = await TenderDocumentUpload.findAll({
        where: { tenderId, organizationId: generatorOrg.id, fieldId: requiredFields.map((f) => f.id) },
      });
      const uploadedFieldIds = new Set(uploads.map((u) => u.fieldId));
      const missingDocuments = requiredFields.filter((f) => !uploadedFieldIds.has(f.id)).map((f) => f.label);
      if (missingDocuments.length > 0) {
        return res.status(400).json({
          success: false,
          error: `The following required documents must be uploaded before submitting a bid: ${missingDocuments.join(', ')}`,
          missingDocuments,
        });
      }
    }

    const technicalCiphertextHash = crypto.createHash('sha256').update(technical.ciphertext).digest('hex');
    const financialCiphertextHash = crypto.createHash('sha256').update(financial.ciphertext).digest('hex');

    const bid = await VettingBid.create({
      tenderRef,
      applicantAlias: generatorOrg.name,
      generatorOrgId: generatorOrg.id,
      technicalWrappedKey: technical.wrappedDataKey,
      technicalIv: technical.iv,
      technicalCiphertext: technical.ciphertext,
      technicalCiphertextHash,
      financialWrappedKey: financial.wrappedDataKey,
      financialIv: financial.iv,
      financialCiphertext: financial.ciphertext,
      financialCiphertextHash,
    });

    logger.info({ reqId: req.requestId, tenderRef, bidId: bid.id }, '[VETTING] bid submitted');

    res.json({
      success: true,
      id: bid.id,
      receipt: { technicalCiphertextHash, financialCiphertextHash, submittedAt: bid.createdAt },
    });
  } catch (err) {
    next(err);
  }
});

// Technical ceremony — any two of the three technical custodian shares. Reveals plaintext for
// every pending submission in this tenderRef; decides nothing. See the plan's "Post-decision
// durable storage" section for why this plaintext is not itself persisted by this step.
router.post('/vetting-bids/open-technical', ceremonyLimiter, async (req, res, next) => {
  try {
    const parsed = openTechnicalBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }
    const { tenderRef, shares, isEmergency, emergencyJustification } = parsed.data;
    if (isEmergency && !emergencyJustification) {
      return res.status(400).json({ success: false, error: 'emergencyJustification is required when isEmergency is true' });
    }

    const { fingerprint } = getTechnicalKeyConfig();
    const privateKey = await reconstructPrivateKey(decodeShares(shares), fingerprint);

    const bids = await VettingBid.findAll({ where: { tenderRef, technicalStatus: 'pending' } });
    const opened = bids.map((bid) => ({
      id: bid.id,
      applicantAlias: bid.applicantAlias,
      content: openEnvelope(privateKey, {
        wrappedDataKey: bid.technicalWrappedKey,
        iv: bid.technicalIv,
        ciphertext: bid.technicalCiphertext,
      } as SealedEnvelope),
    }));

    const shareFingerprints = shares.map((s) => crypto.createHash('sha256').update(Buffer.from(s, 'base64')).digest('hex'));
    await VettingOpeningAttestation.create({
      tenderRef,
      envelope: 'technical',
      openedSetHash: hashOpenedSet(opened.map((o) => o.id)),
      shareFingerprint1: shareFingerprints[0],
      shareFingerprint2: shareFingerprints[1],
      isEmergency,
      emergencyJustification: emergencyJustification ?? null,
    });

    logger.info(
      { reqId: req.requestId, tenderRef, openedCount: opened.length, isEmergency },
      '[VETTING] technical ceremony completed'
    );

    res.json({ success: true, opened });
  } catch (err) {
    next(err);
  }
});

// Technical decision — a separate action from the ceremony above by design: cryptographic opening
// and business approval are different things. Also the point where content moves into durable,
// KMS-protected storage (VettingDecidedRecord) — see the plan for why this must happen for BOTH
// approved and rejected submissions (a rejected generator disputing their rejection still needs
// the record to exist later).
router.post('/vetting-bids/:id/technical-decision', ceremonyLimiter, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid submission id' });

    const parsed = technicalDecisionBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }
    const { decision, reviewedContent } = parsed.data;

    const bid = await VettingBid.findByPk(id);
    if (!bid) return res.status(404).json({ success: false, error: 'Submission not found' });

    const attestation = await VettingOpeningAttestation.findOne({ where: { tenderRef: bid.tenderRef, envelope: 'technical' } });
    if (!attestation) {
      return res.status(409).json({ success: false, error: 'No technical ceremony has been run for this tender yet — cannot record a decision on unopened content' });
    }

    await bid.update({ technicalStatus: decision });

    const decidedAt = new Date();
    await VettingDecidedRecord.create({
      vettingBidId: bid.id,
      envelope: 'technical',
      encryptedContent: await encryptField(reviewedContent),
      decidedAt,
    });

    // EMD is a physical Bank Guarantee now, not money (see EmdSubmission) — a technical rejection
    // no longer auto-refunds anything; admin sees this generator's EMD still 'submitted' in the
    // EMD console (emdSubmissions.ts) and releases it manually, since returning a document is a
    // real-world action, not a state flip this route can perform on its own.

    logger.info({ reqId: req.requestId, bidId: bid.id, tenderRef: bid.tenderRef, decision }, '[VETTING] technical decision recorded');

    res.json({ success: true, id: bid.id, technicalStatus: decision });
  } catch (err) {
    next(err);
  }
});

// Financial ceremony — gated on at least one technical decision existing for the tender, and
// only ever decrypts APPROVED submissions' financial envelopes. A rejected submission's financial
// envelope is never decrypted, full stop — not filtered out of the response, never touched at all.
router.post('/vetting-bids/open-financial', ceremonyLimiter, async (req, res, next) => {
  try {
    const parsed = openFinancialBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }
    const { tenderRef, shares } = parsed.data;

    // A recorded decision means technicalStatus has moved off 'pending' — checking for the
    // ceremony *attestation* instead (as an earlier version of this did) is a different, weaker
    // condition: it would let the financial ceremony run right after the technical one, before
    // any actual decision was ever made.
    const hasDecision = await VettingBid.findOne({ where: { tenderRef, technicalStatus: { [Op.ne]: 'pending' } } });
    if (!hasDecision) {
      return res.status(409).json({ success: false, error: 'No technical decision exists yet for this tender — cannot open financial envelopes' });
    }

    const { fingerprint } = getFinancialKeyConfig();
    const privateKey = await reconstructPrivateKey(decodeShares(shares), fingerprint);

    const approvedBids = await VettingBid.findAll({ where: { tenderRef, technicalStatus: 'approved' } });
    const opened = [];
    for (const bid of approvedBids) {
      const content = openEnvelope(privateKey, {
        wrappedDataKey: bid.financialWrappedKey,
        iv: bid.financialIv,
        ciphertext: bid.financialCiphertext,
      } as SealedEnvelope);
      opened.push({ id: bid.id, applicantAlias: bid.applicantAlias, content });
      await VettingDecidedRecord.create({
        vettingBidId: bid.id,
        envelope: 'financial',
        encryptedContent: await encryptField(content),
        decidedAt: new Date(),
      });
    }

    const shareFingerprints = shares.map((s) => crypto.createHash('sha256').update(Buffer.from(s, 'base64')).digest('hex'));
    await VettingOpeningAttestation.create({
      tenderRef,
      envelope: 'financial',
      openedSetHash: hashOpenedSet(opened.map((o) => o.id)),
      shareFingerprint1: shareFingerprints[0],
      shareFingerprint2: shareFingerprints[1],
      isEmergency: false,
    });

    logger.info({ reqId: req.requestId, tenderRef, openedCount: opened.length }, '[VETTING] financial ceremony completed');

    res.json({ success: true, opened });
  } catch (err) {
    next(err);
  }
});

// Lists a tender's submissions without revealing any sealed content — just enough for an admin
// dashboard to show what exists and its current technicalStatus before running a ceremony.
router.get('/vetting-bids', readLimiter, async (req, res, next) => {
  try {
    const tenderRef = typeof req.query.tenderRef === 'string' ? req.query.tenderRef : undefined;
    if (!tenderRef) return res.status(400).json({ success: false, error: 'tenderRef query parameter is required' });

    const bids = await VettingBid.findAll({ where: { tenderRef }, order: [['id', 'ASC']] });
    res.json({
      success: true,
      bids: bids.map((b) => ({ id: b.id, applicantAlias: b.applicantAlias, technicalStatus: b.technicalStatus, createdAt: b.createdAt })),
    });
  } catch (err) {
    next(err);
  }
});

router.get('/vetting-bids/public-keys', readLimiter, async (req, res, next) => {
  try {
    const technical = getTechnicalKeyConfig();
    const financial = getFinancialKeyConfig();
    res.json({
      success: true,
      technical: { publicKeyPem: technical.publicKeyPem, fingerprint: technical.fingerprint },
      financial: { publicKeyPem: financial.publicKeyPem, fingerprint: financial.fingerprint },
    });
  } catch (err) {
    next(err);
  }
});

// Authenticated, access-logged read of durable post-decision content. Auth mechanism decided
// (email + password, see AUTH_STRATEGY_DECISIONS.md) but not built in this pass — deferred
// deliberately, not an oversight. Do not expose this route in any real deployment before that
// lands.
router.get('/vetting-bids/:id/decided-record', readLimiter, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid record id' });

    const record = await VettingDecidedRecord.findByPk(id);
    if (!record) return res.status(404).json({ success: false, error: 'Record not found' });

    logger.info({ reqId: req.requestId, recordId: id, vettingBidId: record.vettingBidId, envelope: record.envelope }, '[VETTING] decided record accessed');

    res.json({ success: true, envelope: record.envelope, decidedAt: record.decidedAt });
    // Content deliberately not decrypted/returned yet — see the auth note above. This endpoint's
    // shape is in place; the decrypt-and-return step is gated on real auth existing first.
  } catch (err) {
    next(err);
  }
});

export default router;
