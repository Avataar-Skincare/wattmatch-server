import { Router } from 'express';
import { jsonRateLimit as rateLimit } from '../lib/rateLimit.js';
import crypto from 'node:crypto';
import { Op } from 'sequelize';
import { z } from 'zod';
import { Tender } from '../models/Tender.js';
import { VettingBid } from '../models/VettingBid.js';
import { VettingOpeningAttestation, type VettingEnvelope } from '../models/VettingOpeningAttestation.js';
import { VettingDecidedRecord } from '../models/VettingDecidedRecord.js';
import { encryptField, decryptField } from '../lib/fieldEncryption.js';
import { redis } from '../lib/redis.js';
import { requireCustodianAuth } from '../middleware/custodianAuth.js';
import { logger } from '../lib/logger.js';

// Independent custodian ceremony — a custodian authenticates via their own emailed, per-(tender,
// envelope) link (middleware/custodianAuth.ts), not an admin login. Key reconstruction and envelope
// decryption both happen in the COMPLETING custodian's browser (see CustodianCeremonyPage.tsx) —
// this server never sees a raw share pair together, only ever one escrowed share at a time (see
// escrowKey below) and, at the very end, the resulting plaintext. That means the server can no
// longer independently verify the decrypted content is genuine the way the old server-side
// open-technical/open-financial could (AES-GCM's auth tag guaranteed correctness there because the
// server ran the decrypt itself, against its own ciphertext). The one thing still independently
// checked here: the claimed opened-bid-id set must exactly match what's actually pending — see
// POST /ceremony/complete.

const router = Router();

const MAX_SHARE_LENGTH = 8192; // generous bound above what a real Shamir share ever is, see vettingBids.ts's identical reasoning
const ESCROW_TTL_MS = 30 * 60 * 1000; // generous for one custodian to submit before the other, short enough not to linger

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

function keyConfigFor(envelope: VettingEnvelope) {
  return envelope === 'technical' ? getTechnicalKeyConfig() : getFinancialKeyConfig();
}

// The set of bids this ceremony is actually opening — technical opens everything still 'pending';
// financial only ever opens already-'approved' submissions (a rejected generator's financial
// envelope is never decrypted, full stop) — identical filters to the old open-technical/open-financial.
async function pendingBidsFor(tenderId: number, envelope: VettingEnvelope) {
  return VettingBid.findAll({
    where: { tenderRef: String(tenderId), technicalStatus: envelope === 'technical' ? 'pending' : 'approved' },
  });
}

function hashOpenedSet(ids: number[]): string {
  return crypto.createHash('sha256').update(JSON.stringify(ids.sort((a, b) => a - b))).digest('hex');
}

// Exported for tenders.ts's ceremony-schedule PATCH — a date change must be blocked not only once a
// ceremony is fully attested (VettingOpeningAttestation) but also mid-ceremony, the moment one
// custodian has already escrowed their share and is waiting on the second: moving the date forward
// would make the second custodian's submission fail the live openAt check below (line ~159) with no
// way to recover except waiting out the escrow's own 30-minute TTL — a stranded ceremony, not a clean
// reschedule.
export function escrowKey(tenderId: number, envelope: VettingEnvelope): string {
  return `vetting_escrow:${tenderId}:${envelope}`;
}

// Ceremonies are rare, human-paced actions — these bound scripted abuse, not legitimate use. Set
// well above what even a custodian re-checking status a few times in a row would ever hit.
const readLimiter = rateLimit({ windowMs: 60 * 1000, limit: 100, standardHeaders: true, legacyHeaders: false });
const shareLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const completeLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

router.get('/vetting-custodian/ceremony', readLimiter, requireCustodianAuth, async (req, res, next) => {
  try {
    const { id: custodianId, tenderId, envelope } = req.custodian!;
    const tender = await Tender.findByPk(tenderId);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });

    const attestation = await VettingOpeningAttestation.findOne({ where: { tenderRef: String(tenderId), envelope } });
    const pendingBids = await pendingBidsFor(tenderId, envelope);

    const raw = await redis.get(escrowKey(tenderId, envelope));
    const escrow = raw ? (JSON.parse(raw) as EscrowRecord) : null;

    const { fingerprint } = keyConfigFor(envelope);
    const openAt = envelope === 'technical' ? tender.technicalBidOpenAt : tender.financialBidOpenAt;

    res.json({
      success: true,
      tenderTitle: tender.title,
      envelope,
      fingerprint,
      scheduledOpenAt: openAt,
      isOpen: Boolean(openAt) && Date.now() >= openAt!.getTime(),
      alreadyCompleted: Boolean(attestation),
      // Only true for the FIRST submitter — genuinely nothing left for them to do but wait,
      // regardless of whether a second custodian has since claimed (and possibly needs to retry)
      // the pairing. The second/completing custodian always sees `false` here (even on a retry
      // after a failure), so they land back on the submit form instead of a dead-end "waiting" page.
      youAlreadySubmitted: escrow?.firstCustodianId === custodianId,
      awaitingSecondCustodian: Boolean(escrow) && escrow!.firstCustodianId !== custodianId && escrow!.secondCustodianId === undefined && !attestation,
      pendingCount: pendingBids.length,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/vetting-custodian/ceremony/sealed-envelopes', readLimiter, requireCustodianAuth, async (req, res, next) => {
  try {
    const { tenderId, envelope } = req.custodian!;
    const bids = await pendingBidsFor(tenderId, envelope);
    res.json({
      success: true,
      envelopes: bids.map((b) => ({
        id: b.id,
        applicantAlias: b.applicantAlias,
        wrappedDataKey: envelope === 'technical' ? b.technicalWrappedKey : b.financialWrappedKey,
        iv: envelope === 'technical' ? b.technicalIv : b.financialIv,
        ciphertext: envelope === 'technical' ? b.technicalCiphertext : b.financialCiphertext,
      })),
    });
  } catch (err) {
    next(err);
  }
});

const shareBodySchema = z.object({ share: z.string().trim().min(1).max(MAX_SHARE_LENGTH) });

interface EscrowRecord {
  firstCustodianId: number;
  encryptedShare: string;
  // Set once a second, different custodian has been handed the pairing — deliberately NOT deleted
  // at that point (see below). Lets that same custodian retry if their browser fails after this
  // point (network drop, closed tab, the client-side Shamir/RSA/AES decrypt throwing) without
  // losing the first custodian's already-escrowed share — previously, the escrow was deleted the
  // instant the second custodian retrieved it, so any failure between here and /ceremony/complete
  // silently destroyed BOTH custodians' progress with nothing distinguishing "never started" from
  // "we lost your work" in the status response.
  secondCustodianId?: number;
}

// First custodian to submit for a given (tender, envelope) has their share escrowed (encrypted,
// short TTL) — cryptographically inert alone, Shamir's threshold guarantee means one share below
// threshold reveals nothing. The second, DIFFERENT custodian's submission retrieves it and gets both
// shares back to combine client-side — this server never holds both at once. The escrow is only
// ever deleted by /ceremony/complete succeeding (or its TTL lapsing) — not here — specifically so
// the second custodian can safely retry this same request if something fails after this point.
router.post('/vetting-custodian/ceremony/share', shareLimiter, requireCustodianAuth, async (req, res, next) => {
  try {
    const { id: custodianId, tenderId, envelope } = req.custodian!;
    const parsed = shareBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }

    const tender = await Tender.findByPk(tenderId);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });

    const openAt = envelope === 'technical' ? tender.technicalBidOpenAt : tender.financialBidOpenAt;
    if (!openAt || Date.now() < openAt.getTime()) {
      return res.status(409).json({ success: false, error: 'This envelope cannot be opened before its scheduled date' });
    }

    const existingAttestation = await VettingOpeningAttestation.findOne({ where: { tenderRef: String(tenderId), envelope } });
    if (existingAttestation) {
      return res.status(409).json({ success: false, error: 'This ceremony has already been completed' });
    }

    // Mirrors open-financial's old gate exactly: the financial envelope can't be opened until at
    // least one technical decision has been recorded for this tender.
    if (envelope === 'financial') {
      const hasDecision = await VettingBid.findOne({ where: { tenderRef: String(tenderId), technicalStatus: { [Op.ne]: 'pending' } } });
      if (!hasDecision) {
        return res.status(409).json({ success: false, error: 'No technical decision exists yet for this tender — cannot open financial envelopes' });
      }
    }

    const key = escrowKey(tenderId, envelope);
    const raw = await redis.get(key);

    if (!raw) {
      const encryptedShare = await encryptField(parsed.data.share);
      const escrow: EscrowRecord = { firstCustodianId: custodianId, encryptedShare };
      await redis.set(key, JSON.stringify(escrow), 'PX', ESCROW_TTL_MS);
      logger.info({ reqId: req.requestId, tenderId, envelope, custodianId }, '[VETTING_CUSTODIAN] first share escrowed');
      return res.json({ success: true, status: 'waiting' });
    }

    const escrow = JSON.parse(raw) as EscrowRecord;
    if (escrow.firstCustodianId === custodianId) {
      return res.status(409).json({ success: false, error: 'You already submitted your share for this ceremony — waiting on a different custodian' });
    }
    if (escrow.secondCustodianId !== undefined && escrow.secondCustodianId !== custodianId) {
      // A third, different custodian tried to join a pairing that's already claimed — this is a
      // 2-of-3 scheme, only two custodians ever get this far for a given ceremony.
      return res.status(409).json({ success: false, error: 'This ceremony is already paired with a different custodian, waiting for them to complete it' });
    }

    const otherShare = await decryptField(escrow.encryptedShare);
    if (escrow.secondCustodianId === undefined) {
      // First time this pairing has been claimed — mark it and refresh the TTL, but do not delete:
      // this same custodian may need to retry this exact call if completion fails downstream.
      const updated: EscrowRecord = { ...escrow, secondCustodianId: custodianId };
      await redis.set(key, JSON.stringify(updated), 'PX', ESCROW_TTL_MS);
      logger.info({ reqId: req.requestId, tenderId, envelope, custodianId }, '[VETTING_CUSTODIAN] second share submitted — ready to decrypt client-side');
    } else {
      logger.info({ reqId: req.requestId, tenderId, envelope, custodianId }, '[VETTING_CUSTODIAN] second custodian re-requested the pairing — retry after an earlier failure');
    }
    res.json({ success: true, status: 'ready', otherShare });
  } catch (err) {
    next(err);
  }
});

const completeBodySchema = z.object({
  openedBidIds: z.array(z.number().int().positive()),
  opened: z.array(z.object({ bidId: z.number().int().positive(), content: z.string().min(1) })),
  shareFingerprints: z.array(z.string().min(1)).length(2),
});

// The completing custodian's browser has already reconstructed the key (verified against the
// expected fingerprint) and decrypted every sealed envelope locally — this just durably records the
// result. The one check the server still makes independently: openedBidIds must exactly match what
// it knows is actually pending for this tender/envelope, so a buggy or malicious client can't claim
// to have opened a different set than reality — see the module comment for what this can't catch.
router.post('/vetting-custodian/ceremony/complete', completeLimiter, requireCustodianAuth, async (req, res, next) => {
  try {
    const { tenderId, envelope } = req.custodian!;
    const parsed = completeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }

    const existingAttestation = await VettingOpeningAttestation.findOne({ where: { tenderRef: String(tenderId), envelope } });
    if (existingAttestation) {
      return res.status(409).json({ success: false, error: 'This ceremony has already been completed' });
    }

    const expectedBids = await pendingBidsFor(tenderId, envelope);
    const expectedIds = new Set(expectedBids.map((b) => b.id));
    const claimedIds = new Set(parsed.data.openedBidIds);
    if (expectedIds.size !== claimedIds.size || [...expectedIds].some((id) => !claimedIds.has(id))) {
      logger.warn(
        { reqId: req.requestId, tenderId, envelope, expected: [...expectedIds], claimed: [...claimedIds] },
        '[VETTING_CUSTODIAN] rejected: opened-set mismatch'
      );
      return res.status(409).json({ success: false, error: 'The opened bid set does not match what is actually pending for this tender/envelope' });
    }

    const decidedAt = new Date();
    for (const { bidId, content } of parsed.data.opened) {
      const encrypted = await encryptField(content);
      await VettingBid.update(
        envelope === 'technical' ? { technicalOpenedContent: encrypted } : { financialOpenedContent: encrypted },
        { where: { id: bidId } }
      );
      // Financial has no separate admin-decision step the way technical does (technical-decision in
      // vettingBids.ts) — a financial envelope, once opened, IS the settled figure. Writing
      // VettingDecidedRecord here (not just the staging column above) matches exactly what the old
      // server-side open-financial did, and vettingAuctionBridge.ts's promote-to-auction reads this
      // table directly to seed the auction's opening bid — this preserves that dependency unchanged.
      if (envelope === 'financial') {
        await VettingDecidedRecord.create({ vettingBidId: bidId, envelope: 'financial', encryptedContent: encrypted, decidedAt });
      }
    }

    await VettingOpeningAttestation.create({
      tenderRef: String(tenderId),
      envelope,
      openedSetHash: hashOpenedSet([...claimedIds]),
      shareFingerprint1: parsed.data.shareFingerprints[0],
      shareFingerprint2: parsed.data.shareFingerprints[1],
      isEmergency: false,
    });

    // Only deleted here, now that completion has actually succeeded — see /ceremony/share's own
    // comment for why it's deliberately left in place until this point.
    await redis.del(escrowKey(tenderId, envelope));

    logger.info({ reqId: req.requestId, tenderId, envelope, openedCount: parsed.data.opened.length }, '[VETTING_CUSTODIAN] ceremony completed');

    res.json({ success: true, openedCount: parsed.data.opened.length });
  } catch (err) {
    next(err);
  }
});

export default router;
