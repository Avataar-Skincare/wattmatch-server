import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { Op } from 'sequelize';
import { z } from 'zod';
import { Tender } from '../models/Tender.js';
import { Organization } from '../models/Organization.js';
import { TenderRequest } from '../models/TenderRequest.js';
import { TenderInvitation } from '../models/TenderInvitation.js';
import { VettingBid } from '../models/VettingBid.js';
import { Payment } from '../models/Payment.js';
import { EmdSubmission } from '../models/EmdSubmission.js';
import { OrganizationToken } from '../models/OrganizationToken.js';
import { verifyOrgToken, signOrgToken, type OrgTokenPayload } from '../lib/orgAuth.js';
import { generateOpaqueToken } from '../lib/passwordAuth.js';
import { sendTenderInvitationEmail, sendAccountCreatedEmail } from '../services/email.js';
import { hasRfsDocumentPaid } from '../services/rfsDocumentAccessService.js';
import { seedDefaultDocumentFields } from '../services/defaultTenderDocumentFields.js';
import { uploadObject, getSignedDownloadUrl } from '../lib/s3.js';
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

const postLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const readLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const inviteLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

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
  })
  .refine((data) => data.buyerOrgId !== undefined || data.tenderRequestId !== undefined, {
    message: 'Either buyerOrgId or tenderRequestId is required',
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

function extractBearerToken(authHeader: string | undefined): string | undefined {
  return authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
}

async function requireOrgAuth(authHeader: string | undefined): Promise<OrgTokenPayload | null> {
  const token = extractBearerToken(authHeader);
  if (!token) return null;
  try {
    return await verifyOrgToken(token);
  } catch {
    return null;
  }
}

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

  const invited: number[] = [];
  for (const gen of generators) {
    const [, created] = await TenderInvitation.findOrCreate({
      where: { tenderId: tender.id, organizationId: gen.id },
      defaults: { tenderId: tender.id, organizationId: gen.id, status: 'invited' },
    });
    if (created) {
      invited.push(gen.id);
      await sendTenderInvitationEmail(gen.contactEmail, tender.title, frontendUrl('/generator-portal'));
    }
  }
  return invited;
}

// A buyer submits a request describing what they want — not a live tender. An internal admin
// reviews it and creates the real, priced Tender (see POST /tenders below). Replaces the old
// buyer-self-service tender posting: buyers no longer set their own tender live directly.
router.post('/tender-requests', postLimiter, async (req, res, next) => {
  try {
    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });
    if (payload.type !== 'buyer') {
      return res.status(403).json({ success: false, error: 'Only buyer organizations can request a tender' });
    }

    const parsed = tenderRequestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }

    const request = await TenderRequest.create({
      buyerOrgId: payload.organizationId,
      title: parsed.data.title,
      requiredCapacityMw: String(parsed.data.requiredCapacityMw),
      requirementsDetail: parsed.data.requirementsDetail ?? null,
    });

    logger.info({ reqId: req.requestId, tenderRequestId: request.id, buyerOrgId: payload.organizationId }, '[TENDER_REQUEST] submitted');

    res.json({ success: true, id: request.id, status: request.status });
  } catch (err) {
    next(err);
  }
});

// A buyer's own requests, including the resulting tenderId once an admin has converted one.
router.get('/tender-requests/mine', readLimiter, async (req, res, next) => {
  try {
    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });
    if (payload.type !== 'buyer') {
      return res.status(403).json({ success: false, error: 'Only buyer organizations have this view' });
    }

    const requests = await TenderRequest.findAll({ where: { buyerOrgId: payload.organizationId }, order: [['id', 'DESC']] });
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

// Admin-only: every pending request awaiting conversion into a real tender.
router.get('/tender-requests', readLimiter, async (req, res, next) => {
  try {
    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });
    if (payload.type !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only admin organizations have this view' });
    }

    const requests = await TenderRequest.findAll({ where: { status: 'pending' }, order: [['id', 'ASC']] });
    res.json({
      success: true,
      requests: requests.map((r) => ({
        id: r.id,
        buyerOrgId: r.buyerOrgId,
        title: r.title,
        requiredCapacityMw: r.requiredCapacityMw,
        requirementsDetail: r.requirementsDetail,
      })),
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
router.post('/tenders', postLimiter, async (req, res, next) => {
  try {
    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });
    if (payload.type !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only admin organizations can create a tender' });
    }

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

    const tender = await Tender.create({
      buyerOrgId: buyerOrg.id,
      title: parsed.data.title,
      requiredCapacityMw: String(parsed.data.requiredCapacityMw),
      requirementsDetail: parsed.data.requirementsDetail ?? null,
      rfsDocumentFeePaise: parsed.data.rfsDocumentFeePaise,
      bidProcessingFeePaise: parsed.data.bidProcessingFeePaise,
      emdAmountPaise: parsed.data.emdAmountPaise,
    });

    if (request) await request.update({ status: 'converted', tenderId: tender.id });

    // Stage 6.3's default document checklist — the buyer can add/delete fields afterward via
    // tenderDocuments.ts, but every tender starts from the plan's own default list rather than an
    // empty registry.
    await seedDefaultDocumentFields(tender.id);

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

async function requireAdminOrg(authHeader: string | undefined): Promise<OrgTokenPayload | { error: true; status: number; message: string }> {
  const payload = await requireOrgAuth(authHeader);
  if (!payload) return { error: true, status: 401, message: 'Missing or invalid organization token' };
  if (payload.type !== 'admin') return { error: true, status: 403, message: 'Only admin organizations can upload tender documents' };
  return payload;
}

// Admin-only: upload/replace the free RfS document — publicly downloadable the moment it's set,
// no purchase required (see GET /tenders/:id/rfs-document below).
router.post('/tenders/:id/rfs-document', postLimiter, tenderDocumentUpload.single('file'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const payload = await requireAdminOrg(req.headers.authorization);
    if ('error' in payload) return res.status(payload.status).json({ success: false, error: payload.message });

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
router.post('/tenders/:id/tender-document', postLimiter, tenderDocumentUpload.single('file'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const payload = await requireAdminOrg(req.headers.authorization);
    if ('error' in payload) return res.status(payload.status).json({ success: false, error: payload.message });

    const tender = await Tender.findByPk(id);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });
    if (!req.file) return res.status(400).json({ success: false, error: 'A PDF file is required' });

    const s3Key = `tenders/${id}/tender-document-${Date.now()}-${req.file.originalname}`;
    await uploadObject(s3Key, req.file.buffer, 'application/pdf');
    await tender.update({ tenderDocumentS3Key: s3Key, tenderDocumentOriginalFilename: req.file.originalname });

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
router.get('/tenders/mine', readLimiter, async (req, res, next) => {
  try {
    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });
    if (payload.type !== 'generator') {
      return res.status(403).json({ success: false, error: 'Only generator organizations have this view' });
    }

    const org = await Organization.findByPk(payload.organizationId);
    if (!org) return res.status(401).json({ success: false, error: 'Unknown organization' });

    const invitations = await TenderInvitation.findAll({ where: { organizationId: org.id } });
    const invitationByTenderId = new Map(invitations.map((i) => [i.tenderId, i]));

    const emdSubmissions = await EmdSubmission.findAll({ where: { organizationId: org.id } });
    const emdByTenderId = new Map(emdSubmissions.map((s) => [s.tenderId, s]));

    const allTenders = await Tender.findAll({ order: [['id', 'DESC']] });

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
      }));

    res.json({ success: true, enrolled, listed });
  } catch (err) {
    next(err);
  }
});

// Admin-only display hint for the "create tender" form — the id itself is a plain Postgres
// auto-increment (Tender.ts), so this is just MAX(id)+1, not a reservation. A concurrent creation
// could still land on this same id; that's fine for a UI hint, the DB sequence is the real source
// of truth. Placed before the /tenders/:id... routes below, matching this file's existing
// literal-path-before-param-path ordering (see /tenders/mine above vs /tenders/:id further down).
router.get('/tenders/next-id', readLimiter, async (req, res, next) => {
  try {
    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });
    if (payload.type !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only admin organizations can see the next tender id' });
    }

    const maxId = (await Tender.max('id')) as number | null;
    res.json({ success: true, nextTenderId: (maxId ?? 0) + 1 });
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
router.post('/tenders/:id/self-enroll', inviteLimiter, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });
    if (payload.type !== 'generator') {
      return res.status(403).json({ success: false, error: 'Only generator organizations can self-enroll' });
    }

    const tender = await Tender.findByPk(id);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });

    const org = await Organization.findByPk(payload.organizationId);
    if (!org) return res.status(401).json({ success: false, error: 'Unknown organization' });

    if (!(await hasRfsDocumentPaid(id, org.contactEmail))) {
      return res.status(402).json({
        success: false,
        error: "The RfS Document fee must be paid before enrolling in this tender",
      });
    }

    const [invitation, created] = await TenderInvitation.findOrCreate({
      where: { tenderId: id, organizationId: payload.organizationId },
      defaults: { tenderId: id, organizationId: payload.organizationId, status: 'accepted', respondedAt: new Date() },
    });
    if (!created && invitation.status !== 'accepted') {
      await invitation.update({ status: 'accepted', respondedAt: new Date() });
    }

    logger.info({ reqId: req.requestId, tenderId: id, organizationId: payload.organizationId }, '[TENDER] self-enrolled');

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
router.get('/tenders/:id/purchase-status', readLimiter, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const tender = await Tender.findByPk(id);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });

    const parsed = purchaseStatusQuerySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ success: false, error: 'Invalid email' });

    let email = parsed.data.email;
    const payload = await requireOrgAuth(req.headers.authorization);
    if (payload && payload.type === 'generator') {
      const org = await Organization.findByPk(payload.organizationId);
      if (org) email = org.contactEmail;
    }

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
router.get('/tenders/:id/tender-document', readLimiter, async (req, res, next) => {
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
    const payload = await requireOrgAuth(req.headers.authorization);
    if (payload && payload.type === 'generator') {
      const org = await Organization.findByPk(payload.organizationId);
      if (org) email = org.contactEmail;
    }
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
router.get('/tenders/:id/matches', readLimiter, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });

    const tender = await Tender.findByPk(id);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });
    if (payload.type !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only admin organizations can view matches for this tender' });
    }

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
router.get('/tenders/:id', readLimiter, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });

    const tender = await Tender.findByPk(id);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });

    let invitationStatus: string | null = null;
    // Buyer identity — deliberately a separate, stricter gate from requirementsDetail. A generator
    // gets enough to prepare and submit a bid (capacity, tech mix, location) once it has paid the
    // RfS Document fee, but never learns WHO the buyer is until it has both paid that fee and
    // actually submitted a bid. This is intentional: it stops a generator from learning the buyer's
    // identity and going around the platform before it has committed anything. Both gates are keyed
    // on the SAME payment check (rfsDocumentAccessService.ts) — applies uniformly whether the
    // generator arrived via auto-invitation or open self-enroll; being invited only means "come
    // consider this tender," it never exempts anyone from the fee.
    let requirementsDetail: string | null = null;
    let buyer: { name: string; contactEmail: string; contactPhone: string } | null = null;
    let buyerLockedReason: string | null = null;

    if (payload.type === 'buyer') {
      if (payload.organizationId !== tender.buyerOrgId) {
        return res.status(403).json({ success: false, error: 'Not authorized to view this tender' });
      }
      requirementsDetail = tender.requirementsDetail;
      const ownBuyer = await Organization.findByPk(tender.buyerOrgId);
      if (ownBuyer) buyer = { name: ownBuyer.name, contactEmail: ownBuyer.contactEmail, contactPhone: ownBuyer.contactPhone };
    } else {
      const invitation = await TenderInvitation.findOne({ where: { tenderId: id, organizationId: payload.organizationId } });
      if (!invitation) {
        return res.status(403).json({ success: false, error: 'This tender is not visible until you are invited' });
      }
      invitationStatus = invitation.status;

      const org = await Organization.findByPk(payload.organizationId);
      if (!org) return res.status(401).json({ success: false, error: 'Unknown organization' });
      const feesPaid = await hasRfsDocumentPaid(id, org.contactEmail);

      if (feesPaid) requirementsDetail = tender.requirementsDetail;

      const hasSubmittedBid = await VettingBid.findOne({
        where: { tenderRef: String(id), generatorOrgId: payload.organizationId },
      });

      if (feesPaid && hasSubmittedBid) {
        const buyerOrg = await Organization.findByPk(tender.buyerOrgId);
        if (buyerOrg) buyer = { name: buyerOrg.name, contactEmail: buyerOrg.contactEmail, contactPhone: buyerOrg.contactPhone };
      } else {
        const missing: string[] = [];
        if (!feesPaid) missing.push('RfS fee not yet paid');
        if (!hasSubmittedBid) missing.push('bid not yet submitted');
        buyerLockedReason = missing.join('; ');
      }
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
      buyerLockedReason,
    });
  } catch (err) {
    next(err);
  }
});

// A generator accepts or declines its invitation. Submission (vettingBids.ts) requires 'accepted'
// specifically — 'invited' alone is not enough to submit a bid, only enough to view the tender.
router.post('/tenders/:id/invitations/respond', readLimiter, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });
    if (payload.type !== 'generator') {
      return res.status(403).json({ success: false, error: 'Only generator organizations respond to invitations' });
    }

    const parsed = respondBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }

    const invitation = await TenderInvitation.findOne({ where: { tenderId: id, organizationId: payload.organizationId } });
    if (!invitation) return res.status(404).json({ success: false, error: 'No invitation found for this tender' });

    await invitation.update({ status: parsed.data.accept ? 'accepted' : 'declined', respondedAt: new Date() });

    logger.info(
      { reqId: req.requestId, tenderId: id, organizationId: payload.organizationId, status: invitation.status },
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
