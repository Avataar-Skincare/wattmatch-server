import { Router, type Request, type Response, type NextFunction } from 'express';
import { jsonRateLimit as rateLimit } from '../lib/rateLimit.js';
import multer from 'multer';
import { z } from 'zod';
import { Tender } from '../models/Tender.js';
import { TenderInvitation } from '../models/TenderInvitation.js';
import { TenderDocumentField, type DocumentEnvelope } from '../models/TenderDocumentField.js';
import { TenderDocumentUpload } from '../models/TenderDocumentUpload.js';
import { VettingOpeningAttestation } from '../models/VettingOpeningAttestation.js';
import { DefaultTenderDocumentTemplate } from '../models/DefaultTenderDocumentTemplate.js';
import { DEFAULT_FIELDS } from '../services/defaultTenderDocumentFields.js';
import { uploadObject, deleteObject, getSignedDownloadUrl } from '../lib/s3.js';
import { authRequired } from '../middleware/auth.js';
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

const readLimiter = rateLimit({ name: 'tenderDocuments:read', windowMs: 60 * 1000, limit: 60 });
const writeLimiter = rateLimit({ name: 'tenderDocuments:write', windowMs: 15 * 60 * 1000, limit: 60 });

// This endpoint is always multipart (see the POST route below), so `required` always arrives as
// the literal string "true"/"false", never a real boolean — z.coerce.boolean() would coerce via
// JS's Boolean(), under which the non-empty string "false" is truthy and silently becomes `true`.
// Preprocessing to compare against the literal string first is what actually respects an
// admin-unchecked "Required" checkbox instead of always saving the field as required.
const stringBoolean = z.preprocess((v) => (typeof v === 'string' ? v === 'true' : v), z.boolean());

// Asked on every per-tender template upload (see the /template route below): does this replace the
// format for THIS tender only, or should it also become the platform-wide default every future
// tender starts with? Defaults to false — uploading a one-off format for a single tender should
// never silently change what every other tender gets.
const templateUploadBodySchema = z.object({ setAsDefault: stringBoolean.optional().default(false) });

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

function s3KeyForTemplate(tenderId: number, fieldId: number, filename: string): string {
  return `tender-documents/${tenderId}/templates/${fieldId}-${Date.now()}-${filename}`;
}

function s3KeyForUpload(tenderId: number, fieldId: number, organizationId: number, filename: string): string {
  return `tender-documents/${tenderId}/uploads/${fieldId}-org${organizationId}-${Date.now()}-${filename}`;
}

function s3KeyForDefaultTemplate(key: string, filename: string): string {
  return `tender-documents/_defaults/${key}-${Date.now()}-${filename}`;
}

// Platform-wide blank-format templates for the fixed DEFAULT_FIELDS checklist (see
// defaultTenderDocumentFields.ts) — upload one here and every subsequently created tender's
// TenderDocumentField row for that key starts pre-filled with it (seedDefaultDocumentFields), no
// per-tender re-upload needed. This never touches any already-created tender's own field row —
// those keep whatever template they were seeded with (or were later given via the per-tender
// POST /tenders/:id/document-fields/:fieldId/template route above, which still works exactly the
// same for one-off overrides on a specific tender).
router.get('/default-document-templates', readLimiter, ...authRequired('admin'), async (_req, res, next) => {
  try {
    const defaults = await DefaultTenderDocumentTemplate.findAll();
    const defaultByKey = new Map(defaults.map((d) => [d.key, d]));

    res.json({
      success: true,
      templates: await Promise.all(
        DEFAULT_FIELDS.map(async (f) => {
          const d = defaultByKey.get(f.key);
          return {
            envelope: f.envelope,
            key: f.key,
            label: f.label,
            hasTemplate: Boolean(d),
            templateOriginalFilename: d?.templateOriginalFilename ?? null,
            templateUrl: d ? await getSignedDownloadUrl(d.templateS3Key) : null,
          };
        })
      ),
    });
  } catch (err) {
    next(err);
  }
});

// Upload or replace the default template for one checklist key. Deliberately does not delete the
// previous default's S3 object (if any) — unlike a fresh per-tender upload, this object may already
// be referenced by every tender seeded before this replacement, so deleting it here would break
// their "View format" links. The orphaned-object cleanup below only ever applies to the file this
// request itself just uploaded, for the case where the DB write right after fails.
router.post('/default-document-templates/:key/template', writeLimiter, ...authRequired('admin'), upload.single('template'), async (req, res, next) => {
  try {
    const key = req.params.key;
    const defaultField = DEFAULT_FIELDS.find((f) => f.key === key);
    if (!defaultField) return res.status(404).json({ success: false, error: `"${key}" is not a recognized default checklist key` });

    if (!req.file) return res.status(400).json({ success: false, error: 'A PDF template file is required' });

    const templateS3Key = s3KeyForDefaultTemplate(key, req.file.originalname);
    await uploadObject(templateS3Key, req.file.buffer, 'application/pdf');

    try {
      await DefaultTenderDocumentTemplate.upsert({
        envelope: defaultField.envelope,
        key,
        templateS3Key,
        templateOriginalFilename: req.file.originalname,
      });
    } catch (err) {
      await deleteObject(templateS3Key).catch((cleanupErr) =>
        logger.error({ err: cleanupErr, templateS3Key }, '[TENDER_DOCS] failed to clean up orphaned default template upload')
      );
      throw err;
    }

    logger.info({ reqId: req.requestId, key }, '[TENDER_DOCS] default template set');

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Removes the default for one key so future tenders seed with no template for it again — same
// "doesn't touch already-created tenders" reasoning as above, so no S3 cleanup here either.
router.delete('/default-document-templates/:key/template', writeLimiter, ...authRequired('admin'), async (req, res, next) => {
  try {
    const key = req.params.key;
    const deleted = await DefaultTenderDocumentTemplate.destroy({ where: { key } });
    if (!deleted) return res.status(404).json({ success: false, error: `No default template set for "${key}"` });

    logger.info({ reqId: req.requestId, key }, '[TENDER_DOCS] default template removed');

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Admin manages every tender's document checklist (buyers have no operational role here at all —
// they register and submit a tender request, WattMatch's own team runs everything from there), or
// a generator holding ANY invitation row (any status) — the checklist itself isn't the sensitive
// content here (the uploaded documents are, separately gated below), so it's fine for an invited
// generator to see what they'll eventually need before formally accepting.
async function requireTenderVisibility(
  tenderId: number,
  org: NonNullable<Request['org']>
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const tender = await Tender.findByPk(tenderId);
  if (!tender) return { ok: false, status: 404, error: 'Tender not found' };

  if (org.type === 'admin') return { ok: true };

  const invitation = await TenderInvitation.findOne({ where: { tenderId, organizationId: org.id } });
  if (!invitation) return { ok: false, status: 403, error: 'This tender is not visible until you are invited' };
  return { ok: true };
}

// Lists the field registry for both envelopes, with a per-field template download link if one
// exists.
router.get('/tenders/:id/document-fields', readLimiter, ...authRequired(), async (req, res, next) => {
  try {
    const tenderId = Number(req.params.id);
    if (!Number.isFinite(tenderId)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const visibility = await requireTenderVisibility(tenderId, req.org!);
    if (!visibility.ok) return res.status(visibility.status).json({ success: false, error: visibility.error });

    const [fields, defaults] = await Promise.all([
      TenderDocumentField.findAll({ where: { tenderId }, order: [['sortOrder', 'ASC']] }),
      DefaultTenderDocumentTemplate.findAll(),
    ]);
    const defaultByKey = new Map(defaults.map((d) => [d.key, d]));

    res.json({
      success: true,
      fields: await Promise.all(
        fields.map(async (f) => {
          const platformDefault = defaultByKey.get(f.key);
          // Tells the admin UI what to ask before an upload: "isDefault" means this field is
          // currently showing the platform-wide format (so a reupload should ask whether to also
          // update that default); "custom" means this tender already has its own one-off format (or
          // this key isn't part of the default checklist at all — see DEFAULT_FIELDS); "none" means
          // no template has ever been attached.
          const templateSource: 'none' | 'default' | 'custom' =
            f.templateS3Key === null ? 'none' : f.templateS3Key === platformDefault?.templateS3Key ? 'default' : 'custom';
          return {
            id: f.id,
            envelope: f.envelope,
            key: f.key,
            label: f.label,
            required: f.required,
            hasTemplate: f.templateS3Key !== null,
            templateUrl: f.templateS3Key ? await getSignedDownloadUrl(f.templateS3Key) : null,
            templateSource,
            canSetAsDefault: DEFAULT_FIELDS.some((d) => d.key === f.key),
          };
        })
      ),
    });
  } catch (err) {
    next(err);
  }
});

// Admin-only: add a custom field on top of the default checklist (Stage 6.3) — buyers have no
// operational role in running a tender once they've requested it. Always multipart so an optional
// blank-template PDF can ride along with the same request as the text fields.
router.post('/tenders/:id/document-fields', writeLimiter, ...authRequired('admin'), upload.single('template'), async (req, res, next) => {
  try {
    const tenderId = Number(req.params.id);
    if (!Number.isFinite(tenderId)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const tender = await Tender.findByPk(tenderId);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });

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

    let field: TenderDocumentField;
    try {
      field = await TenderDocumentField.create({
        tenderId,
        envelope: parsed.data.envelope as DocumentEnvelope,
        key: parsed.data.key,
        label: parsed.data.label,
        required: parsed.data.required,
        templateS3Key,
        templateOriginalFilename,
        sortOrder: (maxSortOrder ?? -1) + 1,
      });
    } catch (err) {
      // The upload above already succeeded — without this, a DB failure here leaves an orphaned
      // object in S3 with nothing ever referencing or cleaning it up. Best-effort: a failure to
      // delete isn't worth obscuring the original error over.
      if (templateS3Key) await deleteObject(templateS3Key).catch((cleanupErr) => logger.error({ err: cleanupErr, templateS3Key }, '[TENDER_DOCS] failed to clean up orphaned template upload'));
      throw err;
    }

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
router.patch('/tenders/:id/document-fields/:fieldId', writeLimiter, ...authRequired('admin'), async (req, res, next) => {
  try {
    const tenderId = Number(req.params.id);
    const fieldId = Number(req.params.fieldId);
    if (!Number.isFinite(tenderId) || !Number.isFinite(fieldId)) {
      return res.status(400).json({ success: false, error: 'Invalid tender or field id' });
    }

    const tender = await Tender.findByPk(tenderId);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });

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
// covers the moment a field is first created — this is the "replace it later" path. This is also the
// exact same route used the very first time an admin fills in a checklist item that had no platform
// default yet (right after tender creation) and when editing an already-live tender later — one
// route covers both moments the admin can be at.
//
// setAsDefault (asked on every upload, see templateUploadBodySchema): whether this format should
// also become the platform-wide default for this key going forward — the same file is referenced
// from both this tender's field and DefaultTenderDocumentTemplate, no duplicate upload needed. Only
// meaningful for a key that's part of the fixed DEFAULT_FIELDS checklist; a tender-specific custom
// field (added via POST /document-fields) has no platform-wide default to set.
router.post('/tenders/:id/document-fields/:fieldId/template', writeLimiter, ...authRequired('admin'), upload.single('template'), async (req, res, next) => {
  try {
    const tenderId = Number(req.params.id);
    const fieldId = Number(req.params.fieldId);
    if (!Number.isFinite(tenderId) || !Number.isFinite(fieldId)) {
      return res.status(400).json({ success: false, error: 'Invalid tender or field id' });
    }

    const tender = await Tender.findByPk(tenderId);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });

    if (!req.file) return res.status(400).json({ success: false, error: 'A PDF template file is required' });

    const parsed = templateUploadBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }

    const field = await TenderDocumentField.findOne({ where: { id: fieldId, tenderId } });
    if (!field) return res.status(404).json({ success: false, error: 'Field not found for this tender' });

    const isDefaultChecklistKey = DEFAULT_FIELDS.some((d) => d.key === field.key);
    if (parsed.data.setAsDefault && !isDefaultChecklistKey) {
      return res.status(400).json({
        success: false,
        error: `"${field.key}" is a custom field for this tender and has no platform-wide default to set`,
      });
    }

    const templateS3Key = s3KeyForTemplate(tenderId, fieldId, req.file.originalname);
    await uploadObject(templateS3Key, req.file.buffer, 'application/pdf');

    try {
      field.templateS3Key = templateS3Key;
      field.templateOriginalFilename = req.file.originalname;
      await field.save();
      if (parsed.data.setAsDefault) {
        await DefaultTenderDocumentTemplate.upsert({
          envelope: field.envelope,
          key: field.key,
          templateS3Key,
          templateOriginalFilename: req.file.originalname,
        });
      }
    } catch (err) {
      // Same reasoning as POST /document-fields above — clean up the object the upload just wrote
      // rather than leave it orphaned with nothing referencing it.
      await deleteObject(templateS3Key).catch((cleanupErr) => logger.error({ err: cleanupErr, templateS3Key }, '[TENDER_DOCS] failed to clean up orphaned template upload'));
      throw err;
    }

    logger.info(
      { reqId: req.requestId, tenderId, fieldId, setAsDefault: parsed.data.setAsDefault },
      '[TENDER_DOCS] field template replaced'
    );

    res.json({ success: true, setAsDefault: parsed.data.setAsDefault });
  } catch (err) {
    next(err);
  }
});

// Admin-only: remove a field (Stage 6.3). Cascades to any uploads already made against it — once
// the requirement is gone, keeping orphaned files around serves no one.
router.delete('/tenders/:id/document-fields/:fieldId', writeLimiter, ...authRequired('admin'), async (req, res, next) => {
  try {
    const tenderId = Number(req.params.id);
    const fieldId = Number(req.params.fieldId);
    if (!Number.isFinite(tenderId) || !Number.isFinite(fieldId)) {
      return res.status(400).json({ success: false, error: 'Invalid tender or field id' });
    }

    const tender = await Tender.findByPk(tenderId);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });

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
router.post('/tenders/:id/document-fields/:fieldId/upload', writeLimiter, ...authRequired('generator'), upload.single('file'), async (req, res, next) => {
  try {
    const tenderId = Number(req.params.id);
    const fieldId = Number(req.params.fieldId);
    if (!Number.isFinite(tenderId) || !Number.isFinite(fieldId)) {
      return res.status(400).json({ success: false, error: 'Invalid tender or field id' });
    }

    const invitation = await TenderInvitation.findOne({
      where: { tenderId, organizationId: req.org!.id, status: 'accepted' },
    });
    if (!invitation) {
      return res.status(403).json({ success: false, error: 'You must accept this tender\'s invitation before uploading documents' });
    }

    const field = await TenderDocumentField.findOne({ where: { id: fieldId, tenderId } });
    if (!field) return res.status(404).json({ success: false, error: 'Field not found for this tender' });

    if (!req.file) return res.status(400).json({ success: false, error: 'A PDF file is required' });

    const s3Key = s3KeyForUpload(tenderId, fieldId, req.org!.id, req.file.originalname);
    await uploadObject(s3Key, req.file.buffer, 'application/pdf');

    let uploadRow: TenderDocumentUpload;
    try {
      [uploadRow] = await TenderDocumentUpload.upsert({
        tenderId,
        organizationId: req.org!.id,
        fieldId,
        s3Key,
        originalFilename: req.file.originalname,
        sizeBytes: req.file.size,
      });
    } catch (err) {
      // Same reasoning as the template-upload routes above — the object just landed in S3; don't
      // leave it orphaned if the row that was supposed to reference it never got written.
      await deleteObject(s3Key).catch((cleanupErr) => logger.error({ err: cleanupErr, s3Key }, '[TENDER_DOCS] failed to clean up orphaned document upload'));
      throw err;
    }

    logger.info(
      { reqId: req.requestId, tenderId, fieldId, organizationId: req.org!.id, uploadId: uploadRow.id },
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
router.get('/tenders/:id/documents/mine', readLimiter, ...authRequired('generator'), async (req, res, next) => {
  try {
    const tenderId = Number(req.params.id);
    if (!Number.isFinite(tenderId)) return res.status(400).json({ success: false, error: 'Invalid tender id' });

    const documents = await buildDocumentStatus(tenderId, req.org!.id);
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
router.get('/tenders/:id/documents/:organizationId', readLimiter, ...authRequired('admin'), async (req, res, next) => {
  try {
    const tenderId = Number(req.params.id);
    const organizationId = Number(req.params.organizationId);
    if (!Number.isFinite(tenderId) || !Number.isFinite(organizationId)) {
      return res.status(400).json({ success: false, error: 'Invalid tender or organization id' });
    }

    const tender = await Tender.findByPk(tenderId);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });

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
