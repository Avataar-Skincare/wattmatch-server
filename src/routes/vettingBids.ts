import { Router } from 'express';
import { jsonRateLimit as rateLimit } from '../lib/rateLimit.js';
import { z } from 'zod';
import crypto from 'node:crypto';
import { Op } from 'sequelize';
import { VettingBid } from '../models/VettingBid.js';
import { VettingOpeningAttestation, type VettingEnvelope } from '../models/VettingOpeningAttestation.js';
import { VettingDecidedRecord } from '../models/VettingDecidedRecord.js';
import { TenderInvitation } from '../models/TenderInvitation.js';
import { Tender } from '../models/Tender.js';
import { Payment } from '../models/Payment.js';
import { TenderDocumentField } from '../models/TenderDocumentField.js';
import { TenderDocumentUpload } from '../models/TenderDocumentUpload.js';
import { EmdSubmission } from '../models/EmdSubmission.js';
import { hasRfsDocumentPaid } from '../services/rfsDocumentAccessService.js';
import { encryptField, decryptField } from '../lib/fieldEncryption.js';
import { logger } from '../lib/logger.js';
import { authRequired } from '../middleware/auth.js';

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

const technicalDecisionBodySchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  // The evaluator's confirmed copy of what the ceremony revealed for this submission — the server
  // never re-derives this itself (that would mean re-running a ceremony), it durably records what
  // was legitimately reviewed. See VETTING_BID_SEALING_IMPLEMENTATION_PLAN.md's "Post-decision
  // durable storage" section for why this is a deliberately different mechanism from the
  // custodian scheme, not a weaker version of it.
  reviewedContent: z.string().min(1).max(MAX_ENVELOPE_FIELD_LENGTH * 4),
});

const openedContentQuerySchema = z.object({ envelope: z.enum(['technical', 'financial']) });

// Submission requires a real generator org token + accepted invitation (see the route below).
// Ceremonies now happen entirely through routes/vettingCustodian.ts, authenticated by a custodian's
// own emailed link, not an admin login — see that file's own comment for why. Decisions and the
// list/decided-record/opened views here stay admin-only (authRequired('admin')); public-keys is
// any-authenticated-org since the keys aren't secret, but gating it removes anonymous surface area
// for free — there's no legitimate anonymous caller.
const submitLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
const decisionLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
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

// Submission — seals both envelopes client-side before this is ever called; this route only
// stores opaque ciphertext, never plaintext, for either envelope. Also gated on invitation: a
// generator must hold a valid token AND an 'accepted' TenderInvitation for this tenderRef, closing
// the gap where any caller could submit a bid against any tenderRef under a made-up name.
router.post('/vetting-bids', submitLimiter, ...authRequired('generator'), async (req, res, next) => {
  try {
    const parsed = submitBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }
    const { tenderRef, technical, financial } = parsed.data;

    const generatorOrg = req.org!;

    const tenderId = Number(tenderRef);
    if (!Number.isFinite(tenderId)) {
      return res.status(400).json({ success: false, error: 'tenderRef must be a real tender id' });
    }

    const tender = await Tender.findByPk(tenderId);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });
    if (tender.bidSubmissionDeadline && Date.now() > tender.bidSubmissionDeadline.getTime()) {
      return res.status(409).json({ success: false, error: 'The bid submission deadline for this tender has passed' });
    }

    const invitation = await TenderInvitation.findOne({
      where: { tenderId, organizationId: generatorOrg.id, status: 'accepted' },
    });
    if (!invitation) {
      return res.status(403).json({ success: false, error: 'You must accept this tender\'s invitation before submitting a bid' });
    }

    // One sealed bid per generator per tender — nothing else in this pipeline expects more than one
    // (the vetting queue, technical/financial decisions, and the eventual auction seat all key off a
    // single VettingBid per generatorOrgId+tenderRef). Without this, the frontend leaving the form
    // open and reachable after a successful submission (GeneratorBidSubmissionPage) had no server-side
    // backstop against a second, duplicate submission.
    const existingBid = await VettingBid.findOne({ where: { tenderRef: String(tenderId), generatorOrgId: generatorOrg.id } });
    if (existingBid) {
      return res.status(409).json({ success: false, error: 'You have already submitted a bid for this tender', bidId: existingBid.id });
    }

    // Payment gate (TENDER_WORKFLOW_STAKEHOLDER_PLAN.md Stage 6): both the RfS Document fee and the
    // Bid Processing Fee are due BEFORE final submission, not after. The RfS Document fee is
    // re-checked here (on top of invitations/respond's own check on accept) rather than trusted from
    // acceptance time — an invitation accepted before that check existed, or before the fee was ever
    // paid under some other gap, must not still be able to reach a real bid submission; this route is
    // the actual point that matters; accept-time is just the earliest place to give a clear error.
    // e-KYC (also in that Stage 6 sequence) has no gate here yet — it's still blocked on a vendor
    // decision, flagged elsewhere, not silently skipped.
    const missingFees: string[] = [];
    if (!(await hasRfsDocumentPaid(tenderId, generatorOrg.contactEmail))) missingFees.push('RfS Document Fee');
    const bidProcessingPayment = await Payment.findOne({
      where: { tenderId, organizationId: generatorOrg.id, purpose: 'bid_processing', status: 'paid' },
    });
    if (!bidProcessingPayment) missingFees.push('Bid Processing Fee');
    if (missingFees.length > 0) {
      return res.status(402).json({
        success: false,
        error: `The following fees must be paid before submitting a bid: ${missingFees.join(', ')}`,
        missingFees,
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

// Technical decision — a separate action from the custodian ceremony (routes/vettingCustodian.ts) by
// design: cryptographic opening and business approval are different things. Also the point where
// content moves into durable, KMS-protected storage (VettingDecidedRecord) — this must happen for
// BOTH approved and rejected submissions (a rejected generator disputing their rejection still needs
// the record to exist later). reviewedContent is the admin's confirmed copy of what
// GET /vetting-bids/:tenderRef/opened/technical showed them — the server never re-derives this
// itself, it durably records what was legitimately reviewed.
router.post('/vetting-bids/:id/technical-decision', decisionLimiter, ...authRequired('admin'), async (req, res, next) => {
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

// Lists a tender's submissions without revealing any sealed content — just enough for an admin
// dashboard to show what exists, its current technicalStatus, and whether a custodian ceremony has
// already opened content admin can review (routes/vettingCustodian.ts).
router.get('/vetting-bids', readLimiter, ...authRequired('admin'), async (req, res, next) => {
  try {
    const tenderRef = typeof req.query.tenderRef === 'string' ? req.query.tenderRef : undefined;
    if (!tenderRef) return res.status(400).json({ success: false, error: 'tenderRef query parameter is required' });

    const bids = await VettingBid.findAll({ where: { tenderRef }, order: [['id', 'ASC']] });
    res.json({
      success: true,
      bids: bids.map((b) => ({
        id: b.id,
        applicantAlias: b.applicantAlias,
        technicalStatus: b.technicalStatus,
        createdAt: b.createdAt,
        hasOpenedTechnicalContent: b.technicalOpenedContent !== null,
        hasOpenedFinancialContent: b.financialOpenedContent !== null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Admin-only read of what a custodian ceremony opened for this tender/envelope — the source admin
// copies from into technical-decision's reviewedContent. Separate from decided-record: that route
// serves durable, already-decided history; this one serves the in-between "opened, awaiting a
// decision" state that only exists on VettingBid's own opened-content columns.
router.get('/vetting-bids/:tenderRef/opened/:envelope', readLimiter, ...authRequired('admin'), async (req, res, next) => {
  try {
    const parsedQuery = openedContentQuerySchema.safeParse({ envelope: req.params.envelope });
    if (!parsedQuery.success) return res.status(400).json({ success: false, error: 'envelope must be "technical" or "financial"' });
    const { envelope } = parsedQuery.data;

    const where = envelope === 'technical'
      ? { tenderRef: req.params.tenderRef, technicalOpenedContent: { [Op.ne]: null } }
      : { tenderRef: req.params.tenderRef, financialOpenedContent: { [Op.ne]: null } };
    const bids = await VettingBid.findAll({ where });

    const opened = await Promise.all(
      bids.map(async (b) => ({
        id: b.id,
        applicantAlias: b.applicantAlias,
        content: await decryptField((envelope === 'technical' ? b.technicalOpenedContent : b.financialOpenedContent)!),
      }))
    );

    res.json({ success: true, envelope, opened });
  } catch (err) {
    next(err);
  }
});

router.get('/vetting-bids/public-keys', readLimiter, ...authRequired(), async (req, res, next) => {
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

// Authenticated, access-logged read of durable post-decision content. Admin-only, same as every
// other vetting-decision route — this holds settled bid/KYC content, the most sensitive material
// in the vetting module.
router.get('/vetting-bids/:id/decided-record', readLimiter, ...authRequired('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid record id' });

    const record = await VettingDecidedRecord.findByPk(id);
    if (!record) return res.status(404).json({ success: false, error: 'Record not found' });

    logger.info(
      { reqId: req.requestId, recordId: id, vettingBidId: record.vettingBidId, envelope: record.envelope, requestedBy: req.org!.id },
      '[VETTING] decided record accessed'
    );

    res.json({ success: true, envelope: record.envelope, decidedAt: record.decidedAt });
    // Content still deliberately not decrypted/returned — this endpoint's shape is in place, but
    // returning the actual reviewed content is a separate follow-up, not gated on auth anymore.
  } catch (err) {
    next(err);
  }
});

export default router;
