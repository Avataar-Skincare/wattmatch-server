import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { z } from 'zod';
import { Tender } from '../models/Tender.js';
import { TenderInvitation } from '../models/TenderInvitation.js';
import { EmdSubmission } from '../models/EmdSubmission.js';
import { releaseEmd, invokeEmd } from '../services/emdOutcomeService.js';
import { verifyOrgToken, type OrgTokenPayload } from '../lib/orgAuth.js';
import { uploadObject, getSignedDownloadUrl } from '../lib/s3.js';
import { logger } from '../lib/logger.js';

// EMD as a document (Bank Guarantee), not money — see EmdSubmission's own comment for why this
// replaced the old Payment-based flow entirely. A generator uploads the instrument once per tender
// (upsertable only while still 'submitted' — once admin has released or invoked it, the record is
// final); admin resolves it with an explicit reason, same "always require a reason for a
// consequential action" pattern as the sealed-bid module's emergency-ceremony justification.

const router = Router();

const MAX_STRING_FIELD_LENGTH = 255;
const MAX_REASON_LENGTH = 1000;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB — same bound tenderDocuments.ts uses for a scanned PDF

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      cb(new Error('Only PDF files are accepted'));
      return;
    }
    cb(null, true);
  },
});

const readLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
const writeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const resolveLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const submitBodySchema = z.object({
  bankName: z.string().trim().min(1, 'bankName is required').max(MAX_STRING_FIELD_LENGTH),
  guaranteeNumber: z.string().trim().min(1, 'guaranteeNumber is required').max(MAX_STRING_FIELD_LENGTH),
  amountPaise: z.coerce.number().int().positive('amountPaise must be a positive integer'),
  validUpto: z.string().trim().regex(DATE_ONLY_PATTERN, 'validUpto must be an ISO date (YYYY-MM-DD)'),
  returnRecipientName: z.string().trim().min(1, 'returnRecipientName is required').max(MAX_STRING_FIELD_LENGTH),
  returnAddressLine: z.string().trim().min(1, 'returnAddressLine is required').max(MAX_STRING_FIELD_LENGTH),
  returnCity: z.string().trim().min(1, 'returnCity is required').max(MAX_STRING_FIELD_LENGTH),
  returnState: z.string().trim().min(1, 'returnState is required').max(MAX_STRING_FIELD_LENGTH),
  returnPincode: z.string().trim().min(1, 'returnPincode is required').max(20),
  returnPhone: z.string().trim().min(1, 'returnPhone is required').max(30),
});

const resolveBodySchema = z.object({
  reason: z.string().trim().min(1, 'reason is required').max(MAX_REASON_LENGTH),
  dispatchReference: z.string().trim().max(MAX_STRING_FIELD_LENGTH).optional(),
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

function s3KeyForEmdDocument(tenderId: number, organizationId: number, filename: string): string {
  return `emd-submissions/${tenderId}/${organizationId}-${Date.now()}-${filename}`;
}

function serializeSubmission(s: EmdSubmission, documentUrl: string | null) {
  return {
    id: s.id,
    organizationId: s.organizationId,
    bankName: s.bankName,
    guaranteeNumber: s.guaranteeNumber,
    amountPaise: s.amountPaise,
    validUpto: s.validUpto,
    documentOriginalFilename: s.documentOriginalFilename,
    documentUrl,
    returnRecipientName: s.returnRecipientName,
    returnAddressLine: s.returnAddressLine,
    returnCity: s.returnCity,
    returnState: s.returnState,
    returnPincode: s.returnPincode,
    returnPhone: s.returnPhone,
    status: s.status,
    resolvedAt: s.resolvedAt,
    resolvedReason: s.resolvedReason,
    dispatchReference: s.dispatchReference,
    createdAt: s.createdAt,
  };
}

// Generator submits (or replaces, while still 'submitted') its EMD Bank Guarantee for a tender.
// Gated on an accepted invitation — same bar as document-checklist uploads (tenderDocuments.ts) and
// bid submission itself, since this is part of assembling that same submission.
router.post('/tenders/:id/emd-submission', writeLimiter, upload.single('document'), async (req, res, next) => {
  try {
    const tenderId = Number(req.params.id);
    if (!Number.isFinite(tenderId)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });
    if (payload.type !== 'generator') {
      return res.status(403).json({ success: false, error: 'Only generator organizations submit an EMD' });
    }

    const invitation = await TenderInvitation.findOne({
      where: { tenderId, organizationId: payload.organizationId, status: 'accepted' },
    });
    if (!invitation) {
      return res.status(403).json({ success: false, error: 'You must accept this tender\'s invitation before submitting an EMD' });
    }

    const tender = await Tender.findByPk(tenderId);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });

    const parsed = submitBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }

    const existing = await EmdSubmission.findOne({ where: { tenderId, organizationId: payload.organizationId } });
    if (existing && existing.status !== 'submitted') {
      return res.status(409).json({ success: false, error: `Your EMD for this tender has already been ${existing.status} — it can no longer be replaced` });
    }

    if (!req.file) return res.status(400).json({ success: false, error: 'A scanned PDF of the Bank Guarantee is required' });

    const s3Key = s3KeyForEmdDocument(tenderId, payload.organizationId, req.file.originalname);
    await uploadObject(s3Key, req.file.buffer, 'application/pdf');

    const fields = {
      tenderId,
      organizationId: payload.organizationId,
      bankName: parsed.data.bankName,
      guaranteeNumber: parsed.data.guaranteeNumber,
      amountPaise: parsed.data.amountPaise,
      validUpto: parsed.data.validUpto,
      documentS3Key: s3Key,
      documentOriginalFilename: req.file.originalname,
      returnRecipientName: parsed.data.returnRecipientName,
      returnAddressLine: parsed.data.returnAddressLine,
      returnCity: parsed.data.returnCity,
      returnState: parsed.data.returnState,
      returnPincode: parsed.data.returnPincode,
      returnPhone: parsed.data.returnPhone,
    };

    const submission = existing ? await existing.update(fields) : await EmdSubmission.create(fields);

    logger.info(
      { reqId: req.requestId, tenderId, organizationId: payload.organizationId, submissionId: submission.id, replaced: Boolean(existing) },
      '[EMD] submission recorded'
    );

    res.json({ success: true, id: submission.id });
  } catch (err) {
    next(err);
  }
});

// A generator's own submission status — used to gate/inform the bid-submission page.
router.get('/tenders/:id/emd-submission/mine', readLimiter, async (req, res, next) => {
  try {
    const tenderId = Number(req.params.id);
    if (!Number.isFinite(tenderId)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });
    if (payload.type !== 'generator') {
      return res.status(403).json({ success: false, error: 'Only generator organizations have this view' });
    }

    const submission = await EmdSubmission.findOne({ where: { tenderId, organizationId: payload.organizationId } });
    if (!submission) return res.json({ success: true, submission: null });

    res.json({ success: true, submission: serializeSubmission(submission, null) });
  } catch (err) {
    next(err);
  }
});

// Admin-only: every EMD submission on file for a tender, so admin can decide release/invoke per
// generator.
router.get('/tenders/:id/emd-submissions', readLimiter, async (req, res, next) => {
  try {
    const tenderId = Number(req.params.id);
    if (!Number.isFinite(tenderId)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });
    if (payload.type !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only admin organizations have this view' });
    }

    const submissions = await EmdSubmission.findAll({ where: { tenderId }, order: [['id', 'ASC']] });
    res.json({
      success: true,
      submissions: await Promise.all(
        submissions.map(async (s) => serializeSubmission(s, await getSignedDownloadUrl(s.documentS3Key)))
      ),
    });
  } catch (err) {
    next(err);
  }
});

// Admin marks a generator's EMD as physically returned. Manual and explicit on purpose — see
// EmdSubmission's comment for why there is no automatic trigger any more.
router.post('/tenders/:id/emd-submissions/:organizationId/release', resolveLimiter, async (req, res, next) => {
  try {
    const tenderId = Number(req.params.id);
    const organizationId = Number(req.params.organizationId);
    if (!Number.isFinite(tenderId) || !Number.isFinite(organizationId)) {
      return res.status(400).json({ success: false, error: 'Invalid tender or organization id' });
    }

    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });
    if (payload.type !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only admin organizations can release an EMD' });
    }

    const parsed = resolveBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }

    const outcome = await releaseEmd(tenderId, organizationId, parsed.data.reason, parsed.data.dispatchReference);
    if (!outcome.ok) {
      const status = outcome.reason === 'not_found' ? 404 : 409;
      const error = outcome.reason === 'not_found' ? 'No EMD submission found for this tender/organization' : 'This EMD has already been resolved';
      return res.status(status).json({ success: false, error });
    }

    logger.info({ reqId: req.requestId, tenderId, organizationId, reason: parsed.data.reason }, '[EMD] released via admin route');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Admin marks a generator's EMD as invoked with the issuing bank — the document is not returned.
router.post('/tenders/:id/emd-submissions/:organizationId/invoke', resolveLimiter, async (req, res, next) => {
  try {
    const tenderId = Number(req.params.id);
    const organizationId = Number(req.params.organizationId);
    if (!Number.isFinite(tenderId) || !Number.isFinite(organizationId)) {
      return res.status(400).json({ success: false, error: 'Invalid tender or organization id' });
    }

    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });
    if (payload.type !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only admin organizations can invoke an EMD' });
    }

    const parsed = resolveBodySchema.pick({ reason: true }).safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }

    const outcome = await invokeEmd(tenderId, organizationId, parsed.data.reason);
    if (!outcome.ok) {
      const status = outcome.reason === 'not_found' ? 404 : 409;
      const error = outcome.reason === 'not_found' ? 'No EMD submission found for this tender/organization' : 'This EMD has already been resolved';
      return res.status(status).json({ success: false, error });
    }

    logger.info({ reqId: req.requestId, tenderId, organizationId, reason: parsed.data.reason }, '[EMD] invoked via admin route');
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Same multer-error-handling pattern as tenderDocuments.ts — fileFilter/limit errors surface via
// next(err) before the handler runs, so a try/catch inside it can't catch them.
router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError || (err instanceof Error && err.message === 'Only PDF files are accepted')) {
    return res.status(400).json({ success: false, error: err.message });
  }
  next(err);
});

export default router;
