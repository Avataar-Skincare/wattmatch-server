import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { z } from 'zod';
import { Tender } from '../models/Tender.js';
import { TenderInvitation } from '../models/TenderInvitation.js';
import { TenderDocumentField, type DocumentEnvelope } from '../models/TenderDocumentField.js';
import { TenderDocumentUpload } from '../models/TenderDocumentUpload.js';
import { VettingOpeningAttestation } from '../models/VettingOpeningAttestation.js';
import { verifyOrgToken, type OrgTokenPayload } from '../lib/orgAuth.js';
import { uploadObject, getSignedDownloadUrl } from '../lib/s3.js';
import { logger } from '../lib/logger.js';

const router = Router();

// Stage 6.1/6.2's document checklist: every requirement is one paired control — "View format"
// (download a blank template) + "Upload" (the bidder's filled PDF) — per a per-tender field
// registry an admin/buyer can add to or prune (Stage 6.3). Storage goes through lib/s3.ts (SSE-KMS
// + short-lived signed URLs), not the sealed-bid client-side encryption scheme reserved for the
// technical/financial bid CONTENT itself — see TenderDocumentUpload's own comment for why that's
// the right line to draw, not a shortcut.

const MAX_STRING_FIELD_LENGTH = 255;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB — generous for a scanned PDF, bounded all the same

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
const writeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });

// This endpoint is always multipart (see the POST route below), so `required` always arrives as
// the literal string "true"/"false", never a real boolean — z.coerce.boolean() would coerce via
// JS's Boolean(), under which the non-empty string "false" is truthy and silently becomes `true`.
// Preprocessing to compare against the literal string first is what actually respects an
// admin-unchecked "Required" checkbox instead of always saving the field as required.
const stringBoolean = z.preprocess((v) => (typeof v === 'string' ? v === 'true' : v), z.boolean());

const addFieldBodySchema = z.object({
  envelope: z.enum(['technical', 'financial']),
  key: z
    .string()
    .trim()
    .min(1, 'key is required')
    .max(100)
    .regex(/^[a-z0-9_]+$/, 'key must be lowercase letters, numbers, and underscores only'),
  label: z.string().trim().min(1, 'label is required').max(MAX_STRING_FIELD_LENGTH),
  required: stringBoolean.optional().default(true),
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

function s3KeyForTemplate(tenderId: number, fieldId: number, filename: string): string {
  return `tender-documents/${tenderId}/templates/${fieldId}-${Date.now()}-${filename}`;
}

function s3KeyForUpload(tenderId: number, fieldId: number, organizationId: number, filename: string): string {
  return `tender-documents/${tenderId}/uploads/${fieldId}-org${organizationId}-${Date.now()}-${filename}`;
}

// Admin manages every tender's document checklist (buyers have no operational role here at all —
// they register and submit a tender request, WattMatch's own team runs everything from there), or
// a generator holding ANY invitation row (any status) — the checklist itself isn't the sensitive
// content here (the uploaded documents are, separately gated below), so it's fine for an invited
// generator to see what they'll eventually need before formally accepting.
async function requireTenderVisibility(
  tenderId: number,
  payload: OrgTokenPayload
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const tender = await Tender.findByPk(tenderId);
  if (!tender) return { ok: false, status: 404, error: 'Tender not found' };

  if (payload.type === 'admin') return { ok: true };

  const invitation = await TenderInvitation.findOne({ where: { tenderId, organizationId: payload.organizationId } });
  if (!invitation) return { ok: false, status: 403, error: 'This tender is not visible until you are invited' };
  return { ok: true };
}

// Lists the field registry for both envelopes, with a per-field template download link if one
// exists.
router.get('/tenders/:id/document-fields', readLimiter, async (req, res, next) => {
  try {
    const tenderId = Number(req.params.id);
    if (!Number.isFinite(tenderId)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });

    const visibility = await requireTenderVisibility(tenderId, payload);
    if (!visibility.ok) return res.status(visibility.status).json({ success: false, error: visibility.error });

    const fields = await TenderDocumentField.findAll({ where: { tenderId }, order: [['sortOrder', 'ASC']] });

    res.json({
      success: true,
      fields: await Promise.all(
        fields.map(async (f) => ({
          id: f.id,
          envelope: f.envelope,
          key: f.key,
          label: f.label,
          required: f.required,
          hasTemplate: f.templateS3Key !== null,
          templateUrl: f.templateS3Key ? await getSignedDownloadUrl(f.templateS3Key) : null,
        }))
      ),
    });
  } catch (err) {
    next(err);
  }
});

// Admin-only: add a custom field on top of the default checklist (Stage 6.3) — buyers have no
// operational role in running a tender once they've requested it. Always multipart so an optional
// blank-template PDF can ride along with the same request as the text fields.
router.post('/tenders/:id/document-fields', writeLimiter, upload.single('template'), async (req, res, next) => {
  try {
    const tenderId = Number(req.params.id);
    if (!Number.isFinite(tenderId)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });

    const tender = await Tender.findByPk(tenderId);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });
    if (payload.type !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only admin organizations can configure this tender\'s document fields' });
    }

    const parsed = addFieldBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }

    const existing = await TenderDocumentField.findOne({ where: { tenderId, key: parsed.data.key } });
    if (existing) {
      return res.status(409).json({ success: false, error: `A field with key "${parsed.data.key}" already exists for this tender` });
    }

    const maxSortOrder = (await TenderDocumentField.max('sortOrder', { where: { tenderId } })) as number | null;

    let templateS3Key: string | null = null;
    let templateOriginalFilename: string | null = null;
    if (req.file) {
      templateS3Key = s3KeyForTemplate(tenderId, Date.now(), req.file.originalname);
      templateOriginalFilename = req.file.originalname;
      await uploadObject(templateS3Key, req.file.buffer, 'application/pdf');
    }

    const field = await TenderDocumentField.create({
      tenderId,
      envelope: parsed.data.envelope as DocumentEnvelope,
      key: parsed.data.key,
      label: parsed.data.label,
      required: parsed.data.required,
      templateS3Key,
      templateOriginalFilename,
      sortOrder: (maxSortOrder ?? -1) + 1,
    });

    logger.info({ reqId: req.requestId, tenderId, fieldId: field.id, key: field.key }, '[TENDER_DOCS] field added');

    res.json({ success: true, id: field.id });
  } catch (err) {
    next(err);
  }
});

const updateFieldBodySchema = z.object({ required: stringBoolean });

// Admin-only: flip a field's required/optional flag without deleting and re-adding it (Stage 6.3)
// — re-adding via POST loses any uploads already made against the old row (DELETE cascades them),
// which a pure required/optional toggle has no reason to throw away.
router.patch('/tenders/:id/document-fields/:fieldId', writeLimiter, async (req, res, next) => {
  try {
    const tenderId = Number(req.params.id);
    const fieldId = Number(req.params.fieldId);
    if (!Number.isFinite(tenderId) || !Number.isFinite(fieldId)) {
      return res.status(400).json({ success: false, error: 'Invalid tender or field id' });
    }

    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });

    const tender = await Tender.findByPk(tenderId);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });
    if (payload.type !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only admin organizations can configure this tender\'s document fields' });
    }

    const parsed = updateFieldBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }

    const field = await TenderDocumentField.findOne({ where: { id: fieldId, tenderId } });
    if (!field) return res.status(404).json({ success: false, error: 'Field not found for this tender' });

    field.required = parsed.data.required;
    await field.save();

    logger.info({ reqId: req.requestId, tenderId, fieldId, required: field.required }, '[TENDER_DOCS] field required flag updated');

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Admin-only: upload or swap out a field's blank-format template PDF without deleting/re-adding the
// field itself (which would cascade away any bidder uploads already made against it, per the DELETE
// route below). Separate from the template optionally attached on POST /document-fields, which only
// covers the moment a field is first created — this is the "replace it later" path.
router.post('/tenders/:id/document-fields/:fieldId/template', writeLimiter, upload.single('template'), async (req, res, next) => {
  try {
    const tenderId = Number(req.params.id);
    const fieldId = Number(req.params.fieldId);
    if (!Number.isFinite(tenderId) || !Number.isFinite(fieldId)) {
      return res.status(400).json({ success: false, error: 'Invalid tender or field id' });
    }

    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });

    const tender = await Tender.findByPk(tenderId);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });
    if (payload.type !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only admin organizations can configure this tender\'s document fields' });
    }

    if (!req.file) return res.status(400).json({ success: false, error: 'A PDF template file is required' });

    const field = await TenderDocumentField.findOne({ where: { id: fieldId, tenderId } });
    if (!field) return res.status(404).json({ success: false, error: 'Field not found for this tender' });

    const templateS3Key = s3KeyForTemplate(tenderId, fieldId, req.file.originalname);
    await uploadObject(templateS3Key, req.file.buffer, 'application/pdf');

    field.templateS3Key = templateS3Key;
    field.templateOriginalFilename = req.file.originalname;
    await field.save();

    logger.info({ reqId: req.requestId, tenderId, fieldId }, '[TENDER_DOCS] field template replaced');

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Admin-only: remove a field (Stage 6.3). Cascades to any uploads already made against it — once
// the requirement is gone, keeping orphaned files around serves no one.
router.delete('/tenders/:id/document-fields/:fieldId', writeLimiter, async (req, res, next) => {
  try {
    const tenderId = Number(req.params.id);
    const fieldId = Number(req.params.fieldId);
    if (!Number.isFinite(tenderId) || !Number.isFinite(fieldId)) {
      return res.status(400).json({ success: false, error: 'Invalid tender or field id' });
    }

    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });

    const tender = await Tender.findByPk(tenderId);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });
    if (payload.type !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only admin organizations can configure this tender\'s document fields' });
    }

    const field = await TenderDocumentField.findOne({ where: { id: fieldId, tenderId } });
    if (!field) return res.status(404).json({ success: false, error: 'Field not found for this tender' });

    await TenderDocumentUpload.destroy({ where: { fieldId } });
    await field.destroy();

    logger.info({ reqId: req.requestId, tenderId, fieldId }, '[TENDER_DOCS] field removed');

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Generator uploads their filled PDF for one field. Gated on 'accepted' invitation status — the
// same bar as actual bid submission (vettingBids.ts), since these documents are part of assembling
// that same submission, not a separate, looser-gated action.
router.post('/tenders/:id/document-fields/:fieldId/upload', writeLimiter, upload.single('file'), async (req, res, next) => {
  try {
    const tenderId = Number(req.params.id);
    const fieldId = Number(req.params.fieldId);
    if (!Number.isFinite(tenderId) || !Number.isFinite(fieldId)) {
      return res.status(400).json({ success: false, error: 'Invalid tender or field id' });
    }

    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });
    if (payload.type !== 'generator') {
      return res.status(403).json({ success: false, error: 'Only generator organizations upload bid documents' });
    }

    const invitation = await TenderInvitation.findOne({
      where: { tenderId, organizationId: payload.organizationId, status: 'accepted' },
    });
    if (!invitation) {
      return res.status(403).json({ success: false, error: 'You must accept this tender\'s invitation before uploading documents' });
    }

    const field = await TenderDocumentField.findOne({ where: { id: fieldId, tenderId } });
    if (!field) return res.status(404).json({ success: false, error: 'Field not found for this tender' });

    if (!req.file) return res.status(400).json({ success: false, error: 'A PDF file is required' });

    const s3Key = s3KeyForUpload(tenderId, fieldId, payload.organizationId, req.file.originalname);
    await uploadObject(s3Key, req.file.buffer, 'application/pdf');

    const [uploadRow] = await TenderDocumentUpload.upsert({
      tenderId,
      organizationId: payload.organizationId,
      fieldId,
      s3Key,
      originalFilename: req.file.originalname,
      sizeBytes: req.file.size,
    });

    logger.info(
      { reqId: req.requestId, tenderId, fieldId, organizationId: payload.organizationId, uploadId: uploadRow.id },
      '[TENDER_DOCS] document uploaded'
    );

    res.json({ success: true, id: uploadRow.id });
  } catch (err) {
    next(err);
  }
});

async function buildDocumentStatus(tenderId: number, organizationId: number) {
  const [fields, uploads] = await Promise.all([
    TenderDocumentField.findAll({ where: { tenderId }, order: [['sortOrder', 'ASC']] }),
    TenderDocumentUpload.findAll({ where: { tenderId, organizationId } }),
  ]);
  const uploadByFieldId = new Map(uploads.map((u) => [u.fieldId, u]));

  return Promise.all(
    fields.map(async (f) => {
      const u = uploadByFieldId.get(f.id);
      return {
        fieldId: f.id,
        envelope: f.envelope,
        key: f.key,
        label: f.label,
        required: f.required,
        templateUrl: f.templateS3Key ? await getSignedDownloadUrl(f.templateS3Key) : null,
        uploaded: Boolean(u),
        originalFilename: u?.originalFilename ?? null,
        uploadedAt: u?.createdAt ?? null,
        downloadUrl: u ? await getSignedDownloadUrl(u.s3Key) : null,
      };
    })
  );
}

// A generator's own upload status across every field — enough for the bid-submission page to show
// a checklist with what's still missing before they attempt to submit.
router.get('/tenders/:id/documents/mine', readLimiter, async (req, res, next) => {
  try {
    const tenderId = Number(req.params.id);
    if (!Number.isFinite(tenderId)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });
    if (payload.type !== 'generator') {
      return res.status(403).json({ success: false, error: 'Only generator organizations have this view' });
    }

    const documents = await buildDocumentStatus(tenderId, payload.organizationId);
    res.json({ success: true, documents });
  } catch (err) {
    next(err);
  }
});

// Admin-only: review a specific generator's uploaded documents. Gated on the technical envelope's
// opening ceremony having actually run — these checklist documents (financial statements,
// eligibility docs, board resolutions, etc.) are themselves part of what gets evaluated as the
// technical bid, so they carry the same "not even admin can see it early" guarantee the sealed-bid
// ciphertext already gets, not just an ordinary access-control check.
router.get('/tenders/:id/documents/:organizationId', readLimiter, async (req, res, next) => {
  try {
    const tenderId = Number(req.params.id);
    const organizationId = Number(req.params.organizationId);
    if (!Number.isFinite(tenderId) || !Number.isFinite(organizationId)) {
      return res.status(400).json({ success: false, error: 'Invalid tender or organization id' });
    }

    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });

    const tender = await Tender.findByPk(tenderId);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });
    if (payload.type !== 'admin') {
      return res.status(403).json({ success: false, error: 'Only admin organizations can review this tender\'s documents' });
    }

    const technicalOpening = await VettingOpeningAttestation.findOne({
      where: { tenderRef: String(tenderId), envelope: 'technical' },
    });
    if (!technicalOpening) {
      return res.status(409).json({
        success: false,
        error: 'Documents are not visible until the technical envelope\'s opening ceremony has run for this tender',
      });
    }

    const documents = await buildDocumentStatus(tenderId, organizationId);
    res.json({ success: true, documents });
  } catch (err) {
    next(err);
  }
});

// Multer's fileFilter/limit errors surface via next(err) BEFORE the route handler ever runs, so a
// try/catch inside the handlers above can't catch them — a wrong-file-type or too-large upload is
// a client mistake, not a server bug, and deserves a clean 400 rather than falling through to
// index.ts's generic 500 catch-all.
router.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (err instanceof multer.MulterError || (err instanceof Error && err.message === 'Only PDF files are accepted')) {
    return res.status(400).json({ success: false, error: err.message });
  }
  next(err);
});

export default router;
