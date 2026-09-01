import { Router, type Request, type Response, type NextFunction } from 'express';
import { jsonRateLimit as rateLimit } from '../lib/rateLimit.js';
import multer from 'multer';
import { Op } from 'sequelize';
import { z } from 'zod';
import { sequelize } from '../db/sequelize.js';
import { Tender } from '../models/Tender.js';
import { Organization } from '../models/Organization.js';
import { CIRegistration } from '../models/CIRegistration.js';
import { Auction } from '../models/Auction.js';
import { AuctionParticipant } from '../models/AuctionParticipant.js';
import { AuctionBid } from '../models/AuctionBid.js';
import { TenderRequest } from '../models/TenderRequest.js';
import { TenderInvitation } from '../models/TenderInvitation.js';
import { VettingBid } from '../models/VettingBid.js';
import { VettingCustodian } from '../models/VettingCustodian.js';
import { VettingCustodianToken } from '../models/VettingCustodianToken.js';
import { VettingOpeningAttestation } from '../models/VettingOpeningAttestation.js';
import { Payment } from '../models/Payment.js';
import { EmdSubmission } from '../models/EmdSubmission.js';
import { OrganizationToken } from '../models/OrganizationToken.js';
import { signOrgToken } from '../lib/orgAuth.js';
import { generateOpaqueToken } from '../lib/passwordAuth.js';
import { sendTenderInvitationEmail, sendAccountCreatedEmail } from '../services/email.js';
import { hasRfsDocumentPaid } from '../services/rfsDocumentAccessService.js';
import { seedDefaultDocumentFields } from '../services/defaultTenderDocumentFields.js';
import { uploadObject, deleteObject, getSignedDownloadUrl } from '../lib/s3.js';
import { decryptField } from '../lib/fieldEncryption.js';
import { authRequired, optionalAuth } from '../middleware/auth.js';
import { notifyCustodians } from '../services/custodianNotificationService.js';
import { escrowKey } from './vettingCustodian.js';
import { redis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';

const router = Router();

// The two tender-level PDFs admin uploads at/after creation — the RfS document (free) and the
// tender document (gated behind the RfS Document / Bid Purchase fee), as distinct from
// tenderDocuments.ts's per-field bid-compliance checklist.
const MAX_TENDER_DOCUMENT_BYTES = 10 * 1024 * 1024;
const tenderDocumentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_TENDER_DOCUMENT_BYTES },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      cb(new Error('Only PDF files are accepted'));
      return;
    }
    cb(null, true);
  },
});

const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // matches organizations.ts's own TTL for this token purpose

// A safety cap, not real pagination — these listing routes had no limit at all before, so a
// findAll could in principle return every tender the platform has ever created. Generous enough to
// never affect this platform's real (B2B, low-thousands-at-most) tender volume; if it's ever
// actually approached, that's the signal to build real cursor/offset pagination + a frontend to
// match, not to just raise this number.
const MAX_TENDER_LIST_ROWS = 1000;

const postLimiter = rateLimit({ name: 'tenders:post', windowMs: 15 * 60 * 1000, limit: 30 });
const readLimiter = rateLimit({ name: 'tenders:read', windowMs: 60 * 1000, limit: 30 });
const inviteLimiter = rateLimit({ name: 'tenders:invite', windowMs: 15 * 60 * 1000, limit: 30 });
const resendLimiter = rateLimit({ name: 'tenders:resend', windowMs: 15 * 60 * 1000, limit: 10 });

// setTimeout's delay is a 32-bit signed int internally (~24.8 days is the real ceiling) — beyond
// that Node doesn't throw, it silently clamps to firing almost immediately, which would be a real
// bug for a ceremony scheduled further out than that (a real RfS timeline can easily run longer).
// Chains timers under the safe ceiling instead of assuming one setTimeout covers it. Same in-process
// timer tradeoff as vettingAuctionBridge.ts's auction-start scheduling — lost on a restart between
// now and when it fires; recovered via the admin-only resend route below, not a polling subsystem.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;
function scheduleAt(when: Date, callback: () => void): void {
  const delay = when.getTime() - Date.now();
  if (delay <= MAX_TIMEOUT_MS) {
    setTimeout(callback, Math.max(delay, 0));
    return;
  }
  setTimeout(() => scheduleAt(when, callback), MAX_TIMEOUT_MS);
}

function scheduleCustodianNotification(tenderId: number, envelope: 'technical' | 'financial', when: Date): void {
  scheduleAt(when, () => {
    notifyCustodians(tenderId, envelope).catch((err) =>
      logger.error({ err, tenderId, envelope }, '[TENDER] scheduled custodian notification failed')
    );
  });
}

// Admin-only — see the route below. buyerOrgId/tenderRequestId: exactly one path to identify which
// buyer this is for — either convert a pending request (buyerOrgId comes from the request itself)
// or specify the buyer directly for an ad-hoc tender created without one.
const postTenderBodySchema = z
  .object({
    title: z.string().trim().min(1, 'title is required').max(255),
    requiredCapacityMw: z.number().positive('requiredCapacityMw must be a positive number'),
    // Full requirement detail — deliberately separate from the teaser (title + capacity) any matched
    // generator sees before being invited. See Tender.requirementsDetail's comment.
    requirementsDetail: z.string().trim().max(20000).optional(),
    buyerOrgId: z.number().int().positive().optional(),
    tenderRequestId: z.number().int().positive().optional(),
    // Per-tender pricing (TENDER_WORKFLOW_STAKEHOLDER_PLAN.md) — the whole point of admin-only
    // creation is that these are a deliberate per-tender decision, so all three are required here
    // even though the DB column itself has a fallback default for rows created other ways.
    // emdAmountPaise is disclosure only now, not a payment amount — see EmdSubmission.
    rfsDocumentFeePaise: z.number().int().nonnegative(),
    bidProcessingFeePaise: z.number().int().nonnegative(),
    emdAmountPaise: z.number().int().nonnegative(),
    // Ceremony scheduling — deliberately required, not optional-with-a-default: these dates decide
    // when bid submission closes and when custodian ceremony invites go out (see
    // services/custodianNotificationService.ts), so they're a real per-tender admin decision, same
    // reasoning as the pricing fields above, not something to silently default.
    bidSubmissionDeadline: z.string().datetime('bidSubmissionDeadline must be an ISO datetime'),
    technicalBidOpenAt: z.string().datetime('technicalBidOpenAt must be an ISO datetime'),
    financialBidOpenAt: z.string().datetime('financialBidOpenAt must be an ISO datetime'),
    // Per-tender switch: landed-rate auction (equityValue/totalUnitsPerYear required, see below) vs
    // a normal-rate auction (today's original behavior — a single rate, lowest wins). Decided once,
    // deliberately, at creation — same reasoning as the pricing/ceremony fields above.
    useLandedRate: z.boolean(),
    // Landed-rate live-auction inputs (see auctionEngine.ts's computeLandedRate) — only meaningful,
    // and only required, when useLandedRate is true (enforced by the .superRefine below); omitted
    // entirely for a normal-rate tender.
    equityValue: z.number().positive('equityValue must be a positive number').optional(),
    totalUnitsPerYear: z.number().positive('totalUnitsPerYear must be a positive number').optional(),
  })
  .refine((data) => data.buyerOrgId !== undefined || data.tenderRequestId !== undefined, {
    message: 'Either buyerOrgId or tenderRequestId is required',
  })
  .superRefine((data, ctx) => {
    if (!data.useLandedRate) return;
    if (data.equityValue === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'equityValue is required for a landed-rate auction', path: ['equityValue'] });
    }
    if (data.totalUnitsPerYear === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'totalUnitsPerYear is required for a landed-rate auction', path: ['totalUnitsPerYear'] });
    }
  })
  .refine((data) => new Date(data.bidSubmissionDeadline).getTime() > Date.now(), {
    message: 'bidSubmissionDeadline must be in the future',
    path: ['bidSubmissionDeadline'],
  })
  .refine((data) => new Date(data.technicalBidOpenAt).getTime() > new Date(data.bidSubmissionDeadline).getTime(), {
    message: 'technicalBidOpenAt must be after bidSubmissionDeadline',
    path: ['technicalBidOpenAt'],
  })
  .refine((data) => new Date(data.financialBidOpenAt).getTime() > new Date(data.technicalBidOpenAt).getTime(), {
    message: 'financialBidOpenAt must be after technicalBidOpenAt',
    path: ['financialBidOpenAt'],
  });

const tenderRequestBodySchema = z.object({
  title: z.string().trim().min(1, 'title is required').max(255),
  requiredCapacityMw: z.number().positive('requiredCapacityMw must be a positive number'),
  requirementsDetail: z.string().trim().max(20000).optional(),
});

const respondBodySchema = z.object({
  accept: z.boolean(),
});

const publicListQuerySchema = z.object({
  view: z.enum(['live', 'archived', 'completed']).optional(),
});

const enrollBodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  // Best-effort fallback only — the Stage 3 form always collects Mobile as a required structured
  // field now (Payment.payerMobile), so this only matters for rows created before that column
  // existed, or the rare case that lookup somehow comes back empty.
  contactPhone: z.string().trim().min(1).max(255).optional(),
});

function frontendUrl(path: string): string {
  const origin = process.env.CORS_ORIGIN ?? 'http://localhost:5173';
  return `${origin}${path}`;
}

// Automated matching + invitation (TENDER_WORKFLOW_STAKEHOLDER_PLAN.md Stage 4b) — deliberately NOT
// buyer-curated. The buyer never sees or selects individual candidates; every generator whose
// self-declared capacity covers the tender's requirement is invited automatically, the moment the
// tender is created. Known scope gap, not an oversight: this only matches against generators
// already registered at creation time — a generator registering afterward isn't retroactively
// matched. Closing that gap needs a background job (re-run matching on new registration or on a
// schedule) which is out of scope for this pass — see the tech-stack plan's "background job queue"
// note.
async function autoInviteEligibleGenerators(tender: Tender): Promise<number[]> {
  const generators = await Organization.findAll({
    where: { type: 'generator', capacityMw: { [Op.gte]: tender.requiredCapacityMw } },
  });
  if (generators.length === 0) return [];

  // Batched existing-invitation lookup + bulkCreate instead of one findOrCreate per generator inside
  // a loop — that was a genuine N+1 (a separate DB round-trip, plus a blocking email send, per
  // matching generator) sitting directly in the POST /tenders request path, so tender-creation
  // latency used to scale linearly with how many generators matched. Only called once per
  // just-created tender.id, so there's no concurrent caller this could race against.
  const existing = await TenderInvitation.findAll({
    where: { tenderId: tender.id, organizationId: generators.map((g) => g.id) },
  });
  const alreadyInvited = new Set(existing.map((inv) => inv.organizationId));
  const toInvite = generators.filter((g) => !alreadyInvited.has(g.id));
  if (toInvite.length === 0) return [];

  await TenderInvitation.bulkCreate(toInvite.map((g) => ({ tenderId: tender.id, organizationId: g.id, status: 'invited' })));

  // Fire-and-forget, same reasoning as every other notification email in this codebase (e.g.
  // vettingAuctionBridge.ts's join-link emails) — a slow/broken email send must never delay tender
  // creation itself, and no longer blocks the response one generator at a time.
  for (const g of toInvite) {
    sendTenderInvitationEmail(g.contactEmail, tender.title, frontendUrl('/generator-portal')).catch((err) => {
      logger.error({ err, tenderId: tender.id, organizationId: g.id }, '[TENDER] auto-invite email failed — invitation still recorded');
    });
  }

  return toInvite.map((g) => g.id);
}

// A buyer submits a request describing what they want — not a live tender. An internal admin
// reviews it and creates the real, priced Tender (see POST /tenders below). Replaces the old
// buyer-self-service tender posting: buyers no longer set their own tender live directly.
router.post('/tender-requests', postLimiter, ...authRequired('buyer'), async (req, res, next) => {
  try {
    const parsed = tenderRequestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }

    const request = await TenderRequest.create({
      buyerOrgId: req.org!.id,
      title: parsed.data.title,
      requiredCapacityMw: String(parsed.data.requiredCapacityMw),
      requirementsDetail: parsed.data.requirementsDetail ?? null,
    });

    logger.info({ reqId: req.requestId, tenderRequestId: request.id, buyerOrgId: req.org!.id }, '[TENDER_REQUEST] submitted');

    res.json({ success: true, id: request.id, status: request.status });
  } catch (err) {
    next(err);
  }
});

// A buyer's own requests, including the resulting tenderId once an admin has converted one.
router.get('/tender-requests/mine', readLimiter, ...authRequired('buyer'), async (req, res, next) => {
  try {
    const requests = await TenderRequest.findAll({ where: { buyerOrgId: req.org!.id }, order: [['id', 'DESC']] });
    res.json({
      success: true,
      requests: requests.map((r) => ({
        id: r.id,
        title: r.title,
        requiredCapacityMw: r.requiredCapacityMw,
        status: r.status,
        tenderId: r.tenderId,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Admin-only: every pending request awaiting conversion into a real tender. A request's own title
// ("Tender request from X") only ever holds ONE name — not enough to tell an admin who to actually
// contact — so this batch-resolves the buyer's real Organization (name/email/phone, always present)
// and, when the request came from a /ciBuyer registration, the richer CIRegistration record behind
// it (separate person name vs. company, matched by email — there's no direct FK between the two,
// same join admin.ts's own registrations route already does) for its more precise split.
router.get('/tender-requests', readLimiter, ...authRequired('admin'), async (req, res, next) => {
  try {
    const requests = await TenderRequest.findAll({ where: { status: 'pending' }, order: [['id', 'ASC']] });
    const orgs = await Organization.findAll({ where: { id: [...new Set(requests.map((r) => r.buyerOrgId))] } });
    const orgById = new Map(orgs.map((o) => [o.id, o]));
    const registrations = await CIRegistration.findAll({ where: { email: orgs.map((o) => o.contactEmail) } });
    const registrationByEmail = new Map(registrations.map((reg) => [reg.email, reg]));

    res.json({
      success: true,
      requests: requests.map((r) => {
        const org = orgById.get(r.buyerOrgId);
        const registration = org ? registrationByEmail.get(org.contactEmail) : undefined;
        return {
          id: r.id,
          buyerOrgId: r.buyerOrgId,
          title: r.title,
          requiredCapacityMw: r.requiredCapacityMw,
          requirementsDetail: r.requirementsDetail,
          buyerName: registration?.name || org?.name || null,
          buyerCompany: registration?.company || org?.name || null,
          buyerEmail: org?.contactEmail ?? null,
          buyerPhone: org?.contactPhone ?? null,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

// Admin creates the real, priced tender — see TENDER_WORKFLOW_STAKEHOLDER_PLAN.md and the decision
// to move tender creation off self-service: a buyer no longer sets their own tender live, and fees
// are set deliberately per tender (they vary tender to tender), not read from a platform-wide
// stub. Either converts a pending TenderRequest (buyerOrgId comes from it) or creates one ad-hoc
// with an explicit buyerOrgId, for cases handled outside the request flow (e.g. over a call).
router.post('/tenders', postLimiter, ...authRequired('admin'), async (req, res, next) => {
  try {
    const parsed = postTenderBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }

    let buyerOrgId = parsed.data.buyerOrgId ?? null;
    let request: TenderRequest | null = null;
    if (parsed.data.tenderRequestId) {
      request = await TenderRequest.findByPk(parsed.data.tenderRequestId);
      if (!request) return res.status(404).json({ success: false, error: 'Tender request not found' });
      if (request.status !== 'pending') {
        return res.status(409).json({ success: false, error: `This request is already ${request.status}` });
      }
      buyerOrgId = request.buyerOrgId;
    }

    const buyerOrg = buyerOrgId ? await Organization.findByPk(buyerOrgId) : null;
    if (!buyerOrg || buyerOrg.type !== 'buyer') {
      return res.status(400).json({ success: false, error: 'buyerOrgId does not refer to a real buyer organization' });
    }

    // Transactional: previously Tender.create, the source request's status update, and the default
    // document-checklist seed were three separate un-transacted writes — a failure partway (e.g.
    // seedDefaultDocumentFields throwing) left a committed Tender with no document checklist, which
    // every downstream stage (tenderDocuments.ts, vettingBids.ts's required-documents gate) assumes
    // exists. Ceremony scheduling and auto-invite below stay outside the transaction deliberately —
    // they're best-effort notification side effects (timers, blocking email sends), not part of the
    // tender's own core invariant.
    const tender = await sequelize.transaction(async (transaction) => {
      const tender = await Tender.create(
        {
          buyerOrgId: buyerOrg.id,
          title: parsed.data.title,
          requiredCapacityMw: String(parsed.data.requiredCapacityMw),
          requirementsDetail: parsed.data.requirementsDetail ?? null,
          rfsDocumentFeePaise: parsed.data.rfsDocumentFeePaise,
          bidProcessingFeePaise: parsed.data.bidProcessingFeePaise,
          emdAmountPaise: parsed.data.emdAmountPaise,
          bidSubmissionDeadline: new Date(parsed.data.bidSubmissionDeadline),
          technicalBidOpenAt: new Date(parsed.data.technicalBidOpenAt),
          financialBidOpenAt: new Date(parsed.data.financialBidOpenAt),
          useLandedRate: parsed.data.useLandedRate,
          equityValue: parsed.data.equityValue !== undefined ? String(parsed.data.equityValue) : null,
          totalUnitsPerYear: parsed.data.totalUnitsPerYear !== undefined ? String(parsed.data.totalUnitsPerYear) : null,
        },
        { transaction }
      );

      if (request) await request.update({ status: 'converted', tenderId: tender.id }, { transaction });

      // Stage 6.3's default document checklist — the buyer can add/delete fields afterward via
      // tenderDocuments.ts, but every tender starts from the plan's own default list rather than an
      // empty registry.
      await seedDefaultDocumentFields(tender.id, transaction);

      return tender;
    });

    // Custodian ceremony invites fire automatically when each scheduled date arrives — see
    // services/custodianNotificationService.ts and scheduleAt's own comment on the restart caveat.
    scheduleCustodianNotification(tender.id, 'technical', tender.technicalBidOpenAt!);
    scheduleCustodianNotification(tender.id, 'financial', tender.financialBidOpenAt!);

    const invitedOrganizationIds = await autoInviteEligibleGenerators(tender);

    logger.info(
      { reqId: req.requestId, tenderId: tender.id, buyerOrgId: buyerOrg.id, autoInvitedCount: invitedOrganizationIds.length },
      '[TENDER] created by admin'
    );

    res.json({ success: true, tenderId: tender.id, autoInvitedOrganizationIds: invitedOrganizationIds });
  } catch (err) {
    next(err);
  }
});

const envelopeParamSchema = z.enum(['technical', 'financial']);

// Recovery path for scheduleCustodianNotification's one real gap: a server restart between tender
// creation and the scheduled open date loses the in-process timer. Re-runs notifyCustodians
// on demand — also useful any time a custodian's email genuinely just didn't arrive, independent of
// why.
router.post('/tenders/:id/custodian-ceremony/:envelope/resend', resendLimiter, ...authRequired('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const parsedEnvelope = envelopeParamSchema.safeParse(req.params.envelope);
    if (!parsedEnvelope.success) return res.status(400).json({ success: false, error: 'envelope must be "technical" or "financial"' });

    const tender = await Tender.findByPk(id);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });

    await notifyCustodians(id, parsedEnvelope.data);

    logger.info({ reqId: req.requestId, tenderId: id, envelope: parsedEnvelope.data }, '[TENDER] custodian ceremony invites resent');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Admin-only — lets the vetting dashboard tell whether a "custodian invites" click is a genuine
// resend (the scheduled open date has already passed, so the automatic first send either already
// fired or was supposed to) or actually the first send (clicked before that date — notifyCustodians
// itself has no time gate, see its own comment, so calling it early does send, just earlier than
// scheduled). Deliberately its own tiny endpoint rather than folded into a broader tender-detail
// route — this is the one thing the dashboard needs and nothing else.
router.get('/tenders/:id/ceremony-dates', readLimiter, ...authRequired('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const tender = await Tender.findByPk(id);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });

    // How far each ceremony has actually gotten — the previous version of this route only ever
    // returned the scheduled dates, giving admin nothing to tell "everyone's been notified and
    // we're just waiting" apart from "something's stuck, maybe check with the custodians." Counts
    // only (not per-custodian identity) — enough to know whether to click resend, without this
    // admin-facing view needing to name individual custodians.
    const totalCustodians = await VettingCustodian.count();
    const [technicalNotified, financialNotified, technicalAttestation, financialAttestation] = await Promise.all([
      VettingCustodianToken.count({ where: { tenderId: id, envelope: 'technical' } }),
      VettingCustodianToken.count({ where: { tenderId: id, envelope: 'financial' } }),
      VettingOpeningAttestation.findOne({ where: { tenderRef: String(id), envelope: 'technical' } }),
      VettingOpeningAttestation.findOne({ where: { tenderRef: String(id), envelope: 'financial' } }),
    ]);

    res.json({
      success: true,
      bidSubmissionDeadline: tender.bidSubmissionDeadline,
      technicalBidOpenAt: tender.technicalBidOpenAt,
      financialBidOpenAt: tender.financialBidOpenAt,
      technicalCeremony: { notifiedCount: technicalNotified, totalCustodians, completed: Boolean(technicalAttestation) },
      financialCeremony: { notifiedCount: financialNotified, totalCustodians, completed: Boolean(financialAttestation) },
    });
  } catch (err) {
    next(err);
  }
});

const ceremonyScheduleBodySchema = z
  .object({
    bidSubmissionDeadline: z.string().datetime('bidSubmissionDeadline must be an ISO datetime'),
    technicalBidOpenAt: z.string().datetime('technicalBidOpenAt must be an ISO datetime'),
    financialBidOpenAt: z.string().datetime('financialBidOpenAt must be an ISO datetime'),
  })
  .refine((data) => new Date(data.technicalBidOpenAt).getTime() > new Date(data.bidSubmissionDeadline).getTime(), {
    message: 'Technical envelope opens must be after the bid submission deadline',
    path: ['technicalBidOpenAt'],
  })
  .refine((data) => new Date(data.financialBidOpenAt).getTime() > new Date(data.technicalBidOpenAt).getTime(), {
    message: 'Financial envelope opens must be after Technical envelope opens',
    path: ['financialBidOpenAt'],
  });

// Admin-only reschedule of an existing tender's three ceremony-related dates — POST /tenders never
// exposed a way to change these after creation. Deliberately blocks changing a date once its own
// ceremony has moved forward, checked two ways: VettingOpeningAttestation existing means it's fully
// completed (moving the date afterward would rewrite history for something already opened), and a
// live escrow key in Redis means one custodian has already submitted their share and is mid-ceremony
// waiting on the second (see escrowKey's own comment in vettingCustodian.ts) — moving the date
// forward at that point would make the second custodian's submission fail the live openAt check with
// no recovery short of the escrow's own 30-minute TTL expiring, stranding a ceremony that was already
// underway. bidSubmissionDeadline is tied to the SAME 'technical' guard as technicalBidOpenAt itself
// — vetting-bids.ts's own submission gate only ever checks bidSubmissionDeadline against Date.now(),
// with no awareness of whether the technical ceremony has already run; moving the deadline later
// after that ceremony already opened (or is mid-open) would let a new generator sneak in a bid after
// everyone else's were supposed to be final. Only a field that's actually changing is checked —
// leaving a date untouched is fine even if its own ceremony has already completed.
router.patch('/tenders/:id/ceremony-schedule', resendLimiter, ...authRequired('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const parsed = ceremonyScheduleBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }

    const tender = await Tender.findByPk(id);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });

    const newBidSubmissionDeadline = new Date(parsed.data.bidSubmissionDeadline);
    const newTechnicalBidOpenAt = new Date(parsed.data.technicalBidOpenAt);
    const newFinancialBidOpenAt = new Date(parsed.data.financialBidOpenAt);

    // MySQL's DATETIME column stores whole-second precision, not milliseconds — tender.*BidOpenAt
    // read back from the DB has already been truncated, while a client-supplied ISO string (e.g.
    // straight from JS's Date.toISOString()) almost always carries milliseconds. Comparing exact
    // getTime() would treat a genuinely-unchanged date as "changed" purely from that truncation,
    // wrongly tripping the completed/in-progress guard below on a no-op resubmission.
    const secondsEqual = (a: number, b: number) => Math.floor(a / 1000) === Math.floor(b / 1000);

    const changedEnvelopes = new Set<'technical' | 'financial'>();
    if (!tender.bidSubmissionDeadline || !secondsEqual(newBidSubmissionDeadline.getTime(), tender.bidSubmissionDeadline.getTime())) {
      changedEnvelopes.add('technical');
    }
    if (!tender.technicalBidOpenAt || !secondsEqual(newTechnicalBidOpenAt.getTime(), tender.technicalBidOpenAt.getTime())) {
      changedEnvelopes.add('technical');
    }
    if (!tender.financialBidOpenAt || !secondsEqual(newFinancialBidOpenAt.getTime(), tender.financialBidOpenAt.getTime())) {
      changedEnvelopes.add('financial');
    }

    for (const envelope of changedEnvelopes) {
      const attestation = await VettingOpeningAttestation.findOne({ where: { tenderRef: String(id), envelope } });
      if (attestation) {
        return res.status(409).json({
          success: false,
          error: `The ${envelope} ceremony has already been completed — its date can no longer be changed`,
        });
      }
      const escrowed = await redis.get(escrowKey(id, envelope));
      if (escrowed) {
        return res.status(409).json({
          success: false,
          error: `The ${envelope} ceremony is already in progress (a custodian has submitted their share) — its date can no longer be changed`,
        });
      }
    }

    await tender.update({
      bidSubmissionDeadline: newBidSubmissionDeadline,
      technicalBidOpenAt: newTechnicalBidOpenAt,
      financialBidOpenAt: newFinancialBidOpenAt,
    });

    logger.info(
      {
        reqId: req.requestId,
        tenderId: id,
        bidSubmissionDeadline: newBidSubmissionDeadline,
        technicalBidOpenAt: newTechnicalBidOpenAt,
        financialBidOpenAt: newFinancialBidOpenAt,
      },
      '[TENDER] ceremony schedule updated'
    );

    // Deliberately NOT re-scheduling a new in-process timer here (scheduleCustodianNotification) —
    // the original creation-time timer, if still pending, would then race a second one for the same
    // (tenderId, envelope), risking a duplicate notification email. notifyOverdueCustodians' existing
    // self-healing 60-second poll loop already re-derives "should this have been notified by now"
    // fresh from the stored date on every tick, so it picks up a rescheduled-into-the-past date within
    // a minute with no risk of double-firing.
    res.json({
      success: true,
      bidSubmissionDeadline: newBidSubmissionDeadline,
      technicalBidOpenAt: newTechnicalBidOpenAt,
      financialBidOpenAt: newFinancialBidOpenAt,
    });
  } catch (err) {
    next(err);
  }
});

// Admin-only: upload/replace the free RfS document — publicly downloadable the moment it's set,
// no purchase required (see GET /tenders/:id/rfs-document below). Auth runs before multer parses
// the upload, so an unauthorized caller's file body is rejected without ever being read into memory.
router.post('/tenders/:id/rfs-document', postLimiter, ...authRequired('admin'), tenderDocumentUpload.single('file'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const tender = await Tender.findByPk(id);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });
    if (!req.file) return res.status(400).json({ success: false, error: 'A PDF file is required' });

    const s3Key = `tenders/${id}/rfs-document-${Date.now()}-${req.file.originalname}`;
    await uploadObject(s3Key, req.file.buffer, 'application/pdf');
    await tender.update({ rfsDocumentS3Key: s3Key, rfsDocumentOriginalFilename: req.file.originalname });

    logger.info({ reqId: req.requestId, tenderId: id }, '[TENDER] RfS document uploaded');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Admin-only: upload/replace the tender document — stays behind the RfS Document / Bid Purchase
// fee (see hasRfsDocumentPaid) even after upload; only GET /tenders/:id/tender-document ever
// serves it, and that route checks payment first.
router.post('/tenders/:id/tender-document', postLimiter, ...authRequired('admin'), tenderDocumentUpload.single('file'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const tender = await Tender.findByPk(id);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });
    if (!req.file) return res.status(400).json({ success: false, error: 'A PDF file is required' });

    const s3Key = `tenders/${id}/tender-document-${Date.now()}-${req.file.originalname}`;
    await uploadObject(s3Key, req.file.buffer, 'application/pdf');
    try {
      await tender.update({ tenderDocumentS3Key: s3Key, tenderDocumentOriginalFilename: req.file.originalname });
    } catch (err) {
      // The upload above already succeeded — clean up rather than leave an orphaned object in S3
      // with nothing referencing it (same reasoning as tenderDocuments.ts's upload routes).
      await deleteObject(s3Key).catch((cleanupErr) => logger.error({ err: cleanupErr, s3Key }, '[TENDER] failed to clean up orphaned tender-document upload'));
      throw err;
    }

    logger.info({ reqId: req.requestId, tenderId: id }, '[TENDER] tender document uploaded');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Public tender listing (Stage 2) — no account needed, teaser fields only (never
// requirementsDetail or buyer identity). "archived" has no backing concept yet (no tender is ever
// marked archived today) and will simply return empty — flagged here rather than silently invented.
router.get('/tenders', readLimiter, async (req, res, next) => {
  try {
    const parsed = publicListQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'Invalid view parameter' });

    const view = parsed.data.view;
    let statusFilter: string[] | undefined;
    if (view === 'live') statusFilter = ['open', 'vetting', 'live'];
    else if (view === 'completed') statusFilter = ['closed'];
    else if (view === 'archived') statusFilter = []; // no archiving concept exists yet — see comment above

    const tenders = await Tender.findAll({
      where: statusFilter ? { status: statusFilter } : {},
      order: [['id', 'DESC']],
      limit: MAX_TENDER_LIST_ROWS,
    });

    res.json({
      success: true,
      tenders: tenders.map((t) => ({
        id: t.id,
        title: t.title,
        requiredCapacityMw: t.requiredCapacityMw,
        status: t.status,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Generator's own profile view (Stage 5) — two tables in one response: tenders actually enrolled in
// (accepted invitation), and ALL tenders with capacity-matches surfaced at the top (not filtered to
// matches only, per the plan's explicit correction).
router.get('/tenders/mine', readLimiter, ...authRequired('generator'), async (req, res, next) => {
  try {
    const org = req.org!;
    const invitations = await TenderInvitation.findAll({ where: { organizationId: org.id } });
    const invitationByTenderId = new Map(invitations.map((i) => [i.tenderId, i]));

    const emdSubmissions = await EmdSubmission.findAll({ where: { organizationId: org.id } });
    const emdByTenderId = new Map(emdSubmissions.map((s) => [s.tenderId, s]));

    const allTenders = await Tender.findAll({ order: [['id', 'DESC']], limit: MAX_TENDER_LIST_ROWS });

    // RfS Document payments are keyed by payerEmail, not organizationId (see
    // rfsDocumentAccessService.ts — this purchase is deliberately account-less) — one batched lookup
    // across every tender here so "have I bought this one's document" shows up on the dashboard the
    // moment payment clears, not just after separately opening each tender.
    const rfsPayments = await Payment.findAll({
      where: { tenderId: allTenders.map((t) => t.id), payerEmail: org.contactEmail.toLowerCase(), purpose: 'rfs_document', status: 'paid' },
    });
    const rfsPaidTenderIds = new Set(rfsPayments.map((p) => p.tenderId));

    const enrolled = allTenders
      .filter((t) => invitationByTenderId.get(t.id)?.status === 'accepted')
      .map((t) => {
        const emdStatus = emdByTenderId.get(t.id)?.status;
        return {
          id: t.id,
          title: t.title,
          requiredCapacityMw: t.requiredCapacityMw,
          status: t.status,
          stage: emdStatus && emdStatus !== 'submitted' ? 'settled' : t.status,
          rfsDocumentPaid: rfsPaidTenderIds.has(t.id),
        };
      });

    const matchesCapacity = (t: Tender) => org.capacityMw !== null && Number(org.capacityMw) >= Number(t.requiredCapacityMw);
    const listed = [...allTenders]
      .sort((a, b) => Number(matchesCapacity(b)) - Number(matchesCapacity(a)))
      .map((t) => ({
        id: t.id,
        title: t.title,
        requiredCapacityMw: t.requiredCapacityMw,
        status: t.status,
        matchesCapacity: matchesCapacity(t),
        invitationStatus: invitationByTenderId.get(t.id)?.status ?? null,
        rfsDocumentPaid: rfsPaidTenderIds.has(t.id),
      }));

    res.json({ success: true, enrolled, listed });
  } catch (err) {
    next(err);
  }
});

// A buyer's own converted tenders (real Tender rows they own, not the TenderRequest half — see
// GET /tender-requests/mine for those still awaiting conversion) — the dashboard's "current
// tenders" tracker. Auction progress is included since it's the buyer's own next-most-relevant
// status once a tender goes live; the buyer's actual join link/seat still comes from the existing
// GET /auctions/mine (already scoped to both generator AND buyer — see its own comment), not
// duplicated here.
router.get('/tenders/mine-as-buyer', readLimiter, ...authRequired('buyer'), async (req, res, next) => {
  try {
    const org = req.org!;
    const tenders = await Tender.findAll({ where: { buyerOrgId: org.id }, order: [['id', 'DESC']], limit: MAX_TENDER_LIST_ROWS });
    const auctions = await Auction.findAll({ where: { tenderRef: tenders.map((t) => t.id) } });
    const auctionByTenderRef = new Map(auctions.map((a) => [a.tenderRef, a]));

    res.json({
      success: true,
      tenders: tenders.map((t) => {
        const auction = auctionByTenderRef.get(t.id);
        return {
          id: t.id,
          title: t.title,
          requiredCapacityMw: t.requiredCapacityMw,
          status: t.status,
          createdAt: t.createdAt,
          auction: auction ? { id: auction.id, status: auction.status } : null,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

// Admin-only display hint for the "create tender" form — the id itself is a plain Postgres
// auto-increment (Tender.ts), so this is just MAX(id)+1, not a reservation. A concurrent creation
// could still land on this same id; that's fine for a UI hint, the DB sequence is the real source
// of truth. Placed before the /tenders/:id... routes below, matching this file's existing
// literal-path-before-param-path ordering (see /tenders/mine above vs /tenders/:id further down).
router.get('/tenders/next-id', readLimiter, ...authRequired('admin'), async (req, res, next) => {
  try {
    const maxId = (await Tender.max('id')) as number | null;
    res.json({ success: true, nextTenderId: (maxId ?? 0) + 1 });
  } catch (err) {
    next(err);
  }
});

// Admin-only "who won, who was the buyer" history view — every tender, its buyer, and (once
// promoted) its auction's outcome. Literal path, deliberately placed before the generic
// GET /tenders/:id further down — same ordering reason /tenders/next-id above already needs.
// Batched lookups throughout (no N+1): this fetches every tender, then every buyer/auction/winner
// it needs in one query each, not once per tender.
router.get('/tenders/history', readLimiter, ...authRequired('admin'), async (req, res, next) => {
  try {
    const tenders = await Tender.findAll({ order: [['id', 'DESC']], limit: MAX_TENDER_LIST_ROWS });

    const buyerOrgIds = [...new Set(tenders.map((t) => t.buyerOrgId))];
    const buyers = await Organization.findAll({ where: { id: buyerOrgIds } });
    const buyerById = new Map(buyers.map((b) => [b.id, b]));

    // Auction.tenderRef is the link set at promotion time (vettingAuctionBridge.ts) — a tender with
    // no matching row here just hasn't been promoted to a live auction yet.
    const tenderIds = tenders.map((t) => t.id);
    const auctions = await Auction.findAll({ where: { tenderRef: tenderIds } });
    const auctionByTenderRef = new Map(auctions.map((a) => [a.tenderRef, a]));

    const winnerParticipantIds = auctions.map((a) => a.winnerParticipantId).filter((id): id is number => id !== null);
    const winnerParticipants = await AuctionParticipant.findAll({ where: { id: winnerParticipantIds } });
    const winnerParticipantById = new Map(winnerParticipants.map((p) => [p.id, p]));

    // organizationId is the real, non-encrypted FK present on every participant from the real
    // promote-to-auction flow (see AuctionParticipant's own comment) — resolving the live
    // Organization record avoids ever needing to decrypt the auction-time organizationName snapshot
    // in the common case; that decrypt only happens as a fallback for the no-real-org PoC seed path.
    const winnerOrgIds = [...new Set(winnerParticipants.map((p) => p.organizationId).filter((id): id is number => id !== null))];
    const winnerOrgs = await Organization.findAll({ where: { id: winnerOrgIds } });
    const winnerOrgById = new Map(winnerOrgs.map((o) => [o.id, o]));

    // The winning bid's raw rate/returnPercent (as opposed to `currentLowestBid`, which is the
    // already-computed landed/normal rate) — the last *accepted* AuctionBid for a closed auction is
    // definitionally the winning one, since every accepted bid becomes the new leader in turn and
    // the auction's own currentLowestBid/currentLeaderAlias are updated the same way on every one.
    const wonAuctionIds = auctions.filter((a) => a.winnerParticipantId !== null).map((a) => a.id);
    const acceptedBids = await AuctionBid.findAll({ where: { auctionId: wonAuctionIds, accepted: true }, order: [['id', 'ASC']] });
    const winningBidByAuctionId = new Map<number, AuctionBid>();
    for (const bid of acceptedBids) winningBidByAuctionId.set(bid.auctionId, bid); // last one wins, ASC order

    const result = await Promise.all(
      tenders.map(async (t) => {
        const buyer = buyerById.get(t.buyerOrgId);
        const auction = auctionByTenderRef.get(t.id);

        let auctionOut = null;
        if (auction) {
          let winner: { alias: string; organizationName: string | null; rate: string | null; returnPercent: string | null } | null = null;
          if (auction.winnerParticipantId !== null) {
            const wp = winnerParticipantById.get(auction.winnerParticipantId);
            if (wp) {
              const organizationName =
                wp.organizationId !== null ? winnerOrgById.get(wp.organizationId)?.name ?? null : await decryptField(wp.organizationName);
              const winningBid = winningBidByAuctionId.get(auction.id);
              winner = { alias: wp.alias, organizationName, rate: winningBid?.rate ?? null, returnPercent: winningBid?.returnPercent ?? null };
            }
          }
          auctionOut = {
            id: auction.id,
            status: auction.status,
            openingBid: auction.openingBid,
            winningBid: auction.currentLowestBid,
            winner,
          };
        }

        return {
          id: t.id,
          title: t.title,
          requiredCapacityMw: t.requiredCapacityMw,
          status: t.status,
          useLandedRate: t.useLandedRate,
          createdAt: t.createdAt,
          buyer: buyer ? { id: buyer.id, name: buyer.name, email: buyer.contactEmail } : null,
          auction: auctionOut,
        };
      })
    );

    res.json({ success: true, tenders: result });
  } catch (err) {
    next(err);
  }
});

// Stage 4's account-less-purchaser bridge: "a person who has already bought the RfS Document can
// revisit the tender and tap Enroll... an account is compulsory — on creation, login credentials
// are emailed automatically." This is specifically for someone who paid in Stage 3 but never
// separately registered — an already-registered generator uses the authenticated /self-enroll
// route below instead. Public (no Bearer token) since the whole point is there's no account yet.
router.post('/tenders/:id/enroll', inviteLimiter, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const parsed = enrollBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }
    const { email } = parsed.data;

    const tender = await Tender.findByPk(id);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });

    if (!(await hasRfsDocumentPaid(id, email))) {
      return res.status(402).json({ success: false, error: 'The RfS Document fee must be paid before enrolling in this tender' });
    }

    const existingOrg = await Organization.findOne({ where: { contactEmail: email } });
    if (existingOrg) {
      // Never silently attach this enrollment to an existing account — we have no way to verify
      // this caller is actually that account's owner. Direct them to the authenticated path instead.
      return res.status(409).json({
        success: false,
        error: 'An account already exists for this email — log in and enroll from your dashboard',
        accountExists: true,
      });
    }

    const rfsPayment = await Payment.findOne({
      where: { tenderId: id, payerEmail: email, purpose: 'rfs_document', status: 'paid' },
      order: [['id', 'DESC']],
    });
    const contactPhone = rfsPayment?.payerMobile || parsed.data.contactPhone;
    if (!contactPhone) {
      return res.status(400).json({ success: false, error: 'contactPhone is required to create your account' });
    }

    const org = await Organization.create({
      type: 'generator',
      name: rfsPayment?.payerName || email,
      contactEmail: email,
      contactPhone,
      passwordHash: null,
    });

    // Passwordless account, same as the marketing lead-capture forms (registrations.ts) — the
    // caller is logged in immediately below via the returned bearer token regardless, this email
    // is only what lets them log in again on a future visit.
    const { token: setPasswordToken, tokenHash } = generateOpaqueToken();
    await OrganizationToken.create({
      organizationId: org.id,
      purpose: 'password_reset',
      tokenHash,
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    });
    await sendAccountCreatedEmail(email, frontendUrl(`/reset-password?token=${encodeURIComponent(setPasswordToken)}`));

    await TenderInvitation.findOrCreate({
      where: { tenderId: id, organizationId: org.id },
      defaults: { tenderId: id, organizationId: org.id, status: 'accepted', respondedAt: new Date() },
    });

    const token = await signOrgToken({ organizationId: org.id, type: org.type });

    logger.info({ reqId: req.requestId, tenderId: id, organizationId: org.id }, '[TENDER] account auto-created and enrolled');

    res.json({ success: true, status: 'accepted', organizationId: org.id, token, accountCreated: true });
  } catch (err) {
    next(err);
  }
});

// Open self-enroll (Stage 4a) — a generator can enroll directly with no buyer/admin involvement.
// Gated on having already bought the tender's RfS Document (Stage 3) — this applies to
// self-enrolled generators exactly the same as auto-invited ones (invitation only means "come
// consider this tender," it never exempts anyone from the fee). See rfsDocumentAccessService.ts.
router.post('/tenders/:id/self-enroll', inviteLimiter, ...authRequired('generator'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const tender = await Tender.findByPk(id);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });

    const org = req.org!;

    if (!(await hasRfsDocumentPaid(id, org.contactEmail))) {
      return res.status(402).json({
        success: false,
        error: "The RfS Document fee must be paid before enrolling in this tender",
      });
    }

    const [invitation, created] = await TenderInvitation.findOrCreate({
      where: { tenderId: id, organizationId: org.id },
      defaults: { tenderId: id, organizationId: org.id, status: 'accepted', respondedAt: new Date() },
    });
    if (!created && invitation.status !== 'accepted') {
      await invitation.update({ status: 'accepted', respondedAt: new Date() });
    }

    logger.info({ reqId: req.requestId, tenderId: id, organizationId: org.id }, '[TENDER] self-enrolled');

    res.json({ success: true, status: 'accepted' });
  } catch (err) {
    next(err);
  }
});

// Public tender detail (Stage 2's "anyone can open a tender and see its basic details") — unlike
// GET /tenders/:id below, this is unauthenticated and deliberately returns only the teaser fields
// plus per-tender pricing. Never requirementsDetail or buyer identity — those stay gated behind the
// same fee-paid + invitation checks GET /tenders/:id already enforces, for the reasons described there.
router.get('/tenders/:id/public', readLimiter, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const tender = await Tender.findByPk(id);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });

    res.json({
      success: true,
      tender: {
        id: tender.id,
        title: tender.title,
        requiredCapacityMw: tender.requiredCapacityMw,
        status: tender.status,
        rfsDocumentFeePaise: tender.rfsDocumentFeePaise,
        bidProcessingFeePaise: tender.bidProcessingFeePaise,
        emdAmountPaise: tender.emdAmountPaise,
      },
    });
  } catch (err) {
    next(err);
  }
});

const purchaseStatusQuerySchema = z.object({
  email: z.string().trim().toLowerCase().email().optional(),
});

// Backs the public tender-details page's purchase/enroll CTA — the enroll and self-enroll routes
// above already run this same hasRfsDocumentPaid check as a side effect of enrolling, but there was
// no read-only way to ask "would this email/account be allowed to enroll" without attempting it. A
// logged-in generator is checked by their own contactEmail (mirrors self-enroll); anyone else must
// supply the email they paid with (mirrors the account-less enroll bridge).
router.get('/tenders/:id/purchase-status', readLimiter, optionalAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const tender = await Tender.findByPk(id);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });

    const parsed = purchaseStatusQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'Invalid email' });

    let email = parsed.data.email;
    if (req.org?.type === 'generator') email = req.org.contactEmail;

    if (!email) return res.status(400).json({ success: false, error: 'email is required (or log in with a generator account)' });

    const purchased = await hasRfsDocumentPaid(id, email);
    res.json({ success: true, purchased });
  } catch (err) {
    next(err);
  }
});

// Public — the RfS document is free to download the moment it's uploaded, no purchase required
// (that's what distinguishes it from the tender document below).
router.get('/tenders/:id/rfs-document', readLimiter, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const tender = await Tender.findByPk(id);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });
    if (!tender.rfsDocumentS3Key) {
      return res.status(404).json({ success: false, error: 'No RfS document has been uploaded for this tender yet' });
    }

    const url = await getSignedDownloadUrl(tender.rfsDocumentS3Key, 300, tender.rfsDocumentOriginalFilename ?? undefined);
    res.json({ success: true, url, filename: tender.rfsDocumentOriginalFilename });
  } catch (err) {
    next(err);
  }
});

// Gated on the same hasRfsDocumentPaid check as enroll/self-enroll and purchase-status — same dual
// path (logged-in generator's own contactEmail, or an explicit ?email= for the account-less buyer
// who hasn't enrolled yet). This is also the "saved to their profile" access point: once paid,
// this stays fetchable any time the generator is logged in, no separate copy needs to be stored.
router.get('/tenders/:id/tender-document', readLimiter, optionalAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const tender = await Tender.findByPk(id);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });
    if (!tender.tenderDocumentS3Key) {
      return res.status(404).json({ success: false, error: 'No tender document has been uploaded for this tender yet' });
    }

    const parsed = purchaseStatusQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'Invalid email' });

    let email = parsed.data.email;
    if (req.org?.type === 'generator') email = req.org.contactEmail;
    if (!email) return res.status(400).json({ success: false, error: 'email is required (or log in with a generator account)' });

    const purchased = await hasRfsDocumentPaid(id, email);
    if (!purchased) {
      return res.status(402).json({ success: false, error: "This tender's document hasn't been purchased with that email yet" });
    }

    const url = await getSignedDownloadUrl(tender.tenderDocumentS3Key, 300, tender.tenderDocumentOriginalFilename ?? undefined);
    res.json({ success: true, url, filename: tender.tenderDocumentOriginalFilename });
  } catch (err) {
    next(err);
  }
});

// Matching engine — real, if simple: a generator matches if its self-declared capacity covers the
// full requirement. Admin-only visibility — invitations are sent automatically at tender creation
// (see autoInviteEligibleGenerators above); the buyer has no operational role in running a tender
// once they've requested it, admin does (TENDER_WORKFLOW_STAKEHOLDER_PLAN.md Stage 4b). This
// endpoint just shows what the automation already did. See MINIMAL_PIPELINE_INTEGRATION_PLAN.md for
// why deeper eligibility rules (state regulatory compatibility, timeline fit) are a separate,
// larger, already-estimated build.
router.get('/tenders/:id/matches', readLimiter, ...authRequired('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const tender = await Tender.findByPk(id);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });

    const generators = await Organization.findAll({
      where: { type: 'generator', capacityMw: { [Op.gte]: tender.requiredCapacityMw } },
    });

    const invitations = await TenderInvitation.findAll({ where: { tenderId: id } });
    const invitedIds = new Set(invitations.map((i) => i.organizationId));

    res.json({
      success: true,
      tenderId: id,
      matches: generators.map((g) => ({
        organizationId: g.id,
        name: g.name,
        capacityMw: g.capacityMw,
        alreadyInvited: invitedIds.has(g.id),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// Full tender detail — gated. The owning buyer always sees it; a generator sees it only once an
// invitation row exists for them (any status — a declined generator can still see what they
// declined). Everyone else gets a 403, not a 404, so a generator can tell "not invited" apart from
// "doesn't exist" — deliberately, since that distinction is useful and this isn't a secrecy-critical
// boundary the way the sealed-bid content is.
router.get('/tenders/:id', readLimiter, ...authRequired(), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const payload = req.org!;

    const tender = await Tender.findByPk(id);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });

    let invitationStatus: string | null = null;
    // Buyer identity is never revealed to a generator here, at any stage — not once fees are paid,
    // not once a bid is submitted. It's a strictly later, separate reveal: only the winning pair
    // learns each other's identity, only after the auction closes (see auctions.ts's
    // /auctions/:id/winner-identity and its own comment on why). This route only ever returns `buyer`
    // for the owning buyer looking at their own tender — self-info, not a disclosure.
    let requirementsDetail: string | null = null;
    let buyer: { name: string; contactEmail: string; contactPhone: string } | null = null;
    let bidProcessingPaid = false;
    let rfsDocumentPaid = false;
    let bidId: number | null = null;

    if (payload.type === 'buyer') {
      if (payload.id !== tender.buyerOrgId) {
        return res.status(403).json({ success: false, error: 'Not authorized to view this tender' });
      }
      requirementsDetail = tender.requirementsDetail;
      const ownBuyer = await Organization.findByPk(tender.buyerOrgId);
      if (ownBuyer) buyer = { name: ownBuyer.name, contactEmail: ownBuyer.contactEmail, contactPhone: ownBuyer.contactPhone };
    } else {
      const invitation = await TenderInvitation.findOne({ where: { tenderId: id, organizationId: payload.id } });
      if (!invitation) {
        return res.status(403).json({ success: false, error: 'This tender is not visible until you are invited' });
      }
      invitationStatus = invitation.status;

      // RfS Document fee gate (rfsDocumentAccessService.ts) — a generator gets enough to prepare and
      // submit a bid (capacity, tech mix, location) once it's paid, applying uniformly whether it
      // arrived via auto-invitation or open self-enroll; being invited only means "come consider this
      // tender," it never exempts anyone from the fee.
      const feesPaid = await hasRfsDocumentPaid(id, payload.contactEmail);
      rfsDocumentPaid = feesPaid;

      const bidProcessingPayment = await Payment.findOne({
        where: { tenderId: id, organizationId: payload.id, purpose: 'bid_processing', status: 'paid' },
      });
      bidProcessingPaid = !!bidProcessingPayment;

      if (feesPaid) requirementsDetail = tender.requirementsDetail;

      // One sealed bid per generator per tender (see vettingBids.ts's own duplicate-submission
      // guard) — surfaced here so a reload after submitting shows the same "already submitted"
      // confirmation instead of the fillable form again (GeneratorBidSubmissionPage.tsx).
      const submittedBid = await VettingBid.findOne({ where: { tenderRef: String(id), generatorOrgId: payload.id } });
      bidId = submittedBid?.id ?? null;
    }

    res.json({
      success: true,
      tender: {
        id: tender.id,
        title: tender.title,
        requiredCapacityMw: tender.requiredCapacityMw,
        requirementsDetail,
        status: tender.status,
      },
      invitationStatus,
      buyer,
      bidProcessingPaid,
      rfsDocumentPaid,
      bidId,
    });
  } catch (err) {
    next(err);
  }
});

// A generator accepts or declines its invitation. Submission (vettingBids.ts) requires 'accepted'
// specifically — 'invited' alone is not enough to submit a bid, only enough to view the tender.
// Accepting is gated on the same hasRfsDocumentPaid check self-enroll and GET /tenders/:id already
// enforce (see their own comments: "it never exempts anyone from the fee") — this route was the one
// path into 'accepted' that had never actually run that check, letting an auto-invited generator
// walk straight through Bid Processing Fee → document checklist → a real bid submission without ever
// paying the RfS Document fee. Declining needs no such check — there's nothing to gate on a no.
router.post('/tenders/:id/invitations/respond', readLimiter, ...authRequired('generator'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const parsed = respondBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }

    const invitation = await TenderInvitation.findOne({ where: { tenderId: id, organizationId: req.org!.id } });
    if (!invitation) return res.status(404).json({ success: false, error: 'No invitation found for this tender' });

    if (parsed.data.accept && !(await hasRfsDocumentPaid(id, req.org!.contactEmail))) {
      return res.status(402).json({
        success: false,
        error: 'The RfS Document fee must be paid before you can accept this invitation',
      });
    }

    await invitation.update({ status: parsed.data.accept ? 'accepted' : 'declined', respondedAt: new Date() });

    logger.info(
      { reqId: req.requestId, tenderId: id, organizationId: req.org!.id, status: invitation.status },
      '[TENDER] invitation responded'
    );

    res.json({ success: true, status: invitation.status });
  } catch (err) {
    next(err);
  }
});

// Settling an auction winner (or declaring one defaulted) used to be a dedicated route here, gated
// on a Success Charge Payment. Success Charge is dropped from the platform (2026-08-25) and EMD is
// now a document, not money (see EmdSubmission) — there is nothing left for a dedicated
// settle-winner/declare-default route to gate on. Resolving a winner's EMD (release once genuinely
// done, or invoke if they back out) is now just the same generic admin action every other generator
// uses, via emdSubmissions.ts's release/invoke routes.

// Multer's fileFilter/limit errors surface via next(err) BEFORE the route handler ever runs (same
// caveat as tenderDocuments.ts) — a wrong-file-type or too-large upload deserves a clean 400, not
// index.ts's generic 500 catch-all.
router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError || (err instanceof Error && err.message === 'Only PDF files are accepted')) {
    return res.status(400).json({ success: false, error: err.message });
  }
  next(err);
});

export default router;
