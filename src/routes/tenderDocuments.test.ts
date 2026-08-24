import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { Organization } from '../models/Organization.js';
import { Tender } from '../models/Tender.js';
import { TenderInvitation } from '../models/TenderInvitation.js';
import { TenderDocumentField } from '../models/TenderDocumentField.js';
import { TenderDocumentUpload } from '../models/TenderDocumentUpload.js';
import { VettingOpeningAttestation } from '../models/VettingOpeningAttestation.js';
import { signOrgToken } from '../lib/orgAuth.js';

let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let buyerOrgId: number;
let buyerToken: string;
let adminToken: string;
let generatorOrgId: number;
let generatorToken: string;
let tenderId: number;

const createdOrgIds: number[] = [];

beforeAll(async () => {
  const { default: tenderDocumentsRouter } = await import('./tenderDocuments.js');
  const { default: devLocalStorageRouter } = await import('./devLocalStorage.js');
  app = express();
  app.use(express.json());
  app.use('/api', tenderDocumentsRouter);
  // Serves the actual bytes behind the signed-URL-shaped links this router hands back when
  // AWS_S3_BUCKET isn't configured (see lib/s3.ts) — needed for the download-round-trip assertions
  // below to fetch real content instead of 404ing.
  app.use('/api', devLocalStorageRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Internal error' });
  });

  server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
  // lib/s3.ts's local-storage fallback builds signed-URL-shaped links off PUBLIC_API_URL (defaulting
  // to :4000) — point it at THIS test's own ephemeral server, otherwise the template/upload
  // download assertions below only pass by coincidence if something else happens to be listening
  // on 4000, and fail with ECONNREFUSED otherwise (caught directly running the full suite once).
  process.env.PUBLIC_API_URL = baseUrl;

  const buyer = await Organization.create({ type: 'buyer', name: 'Docs Test Buyer', contactEmail: `docs-buyer-${Date.now()}@test.local`, contactPhone: '9000000000' });
  buyerOrgId = buyer.id;
  buyerToken = await signOrgToken({ organizationId: buyer.id, type: 'buyer' });
  createdOrgIds.push(buyer.id);

  const admin = await Organization.create({ type: 'admin', name: 'Docs Test Admin', contactEmail: `docs-admin-${Date.now()}@test.local`, contactPhone: '9000000004' });
  adminToken = await signOrgToken({ organizationId: admin.id, type: 'admin' });
  createdOrgIds.push(admin.id);

  const generator = await Organization.create({ type: 'generator', name: 'Docs Test Generator', contactEmail: `docs-gen-${Date.now()}@test.local`, contactPhone: '9000000001' });
  generatorOrgId = generator.id;
  generatorToken = await signOrgToken({ organizationId: generator.id, type: 'generator' });
  createdOrgIds.push(generator.id);

  const tender = await Tender.create({ buyerOrgId, title: `Docs test tender ${Date.now()}`, requiredCapacityMw: '5' });
  tenderId = tender.id;
  await TenderInvitation.create({ tenderId, organizationId: generatorOrgId, status: 'accepted' });
});

afterAll(async () => {
  await VettingOpeningAttestation.destroy({ where: { tenderRef: String(tenderId) } });
  await TenderDocumentUpload.destroy({ where: { tenderId } });
  await TenderDocumentField.destroy({ where: { tenderId } });
  await TenderInvitation.destroy({ where: { tenderId } });
  await Tender.destroy({ where: { id: tenderId } });
  for (const id of createdOrgIds) await Organization.destroy({ where: { id } });
  await new Promise((resolve) => server.close(resolve));
});

function pdfBuffer(): Buffer {
  return Buffer.from('%PDF-1.4\n%fake test pdf\n');
}

async function postMultipart(path: string, fields: Record<string, string>, file: { field: string; filename: string; content: Buffer; contentType: string } | null, token?: string) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file) form.append(file.field, new Blob([new Uint8Array(file.content)], { type: file.contentType }), file.filename);

  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  return { status: res.status, body: await res.json() };
}

async function get(path: string, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json() };
}

describe('tenderDocuments routes', () => {
  it('an admin can add a custom field, and it appears in the registry', async () => {
    const res = await postMultipart(`/api/tenders/${tenderId}/document-fields`, { envelope: 'technical', key: 'custom_field', label: 'Custom Field' }, null, adminToken);
    expect(res.status).toBe(200);

    const list = await get(`/api/tenders/${tenderId}/document-fields`, adminToken);
    expect(list.status).toBe(200);
    const field = list.body.fields.find((f: { key: string }) => f.key === 'custom_field');
    expect(field).toBeTruthy();
    expect(field.required).toBe(true);
    expect(field.hasTemplate).toBe(false);
  });

  it('rejects a duplicate field key for the same tender', async () => {
    const res = await postMultipart(`/api/tenders/${tenderId}/document-fields`, { envelope: 'technical', key: 'custom_field', label: 'Custom Field Again' }, null, adminToken);
    expect(res.status).toBe(409);
  });

  it('only admin organizations can add or delete fields — the owning buyer has no operational role here', async () => {
    const addRes = await postMultipart(`/api/tenders/${tenderId}/document-fields`, { envelope: 'technical', key: 'sneaky_field', label: 'Sneaky' }, null, buyerToken);
    expect(addRes.status).toBe(403);

    const genRes = await postMultipart(`/api/tenders/${tenderId}/document-fields`, { envelope: 'technical', key: 'sneaky_field_2', label: 'Sneaky 2' }, null, generatorToken);
    expect(genRes.status).toBe(403);
  });

  it('accepts an optional template PDF upload alongside a new field, and it is downloadable', async () => {
    const res = await postMultipart(
      `/api/tenders/${tenderId}/document-fields`,
      { envelope: 'financial', key: 'field_with_template', label: 'Field With Template' },
      { field: 'template', filename: 'template.pdf', content: pdfBuffer(), contentType: 'application/pdf' },
      adminToken
    );
    expect(res.status).toBe(200);

    const list = await get(`/api/tenders/${tenderId}/document-fields`, adminToken);
    const field = list.body.fields.find((f: { key: string }) => f.key === 'field_with_template');
    expect(field.hasTemplate).toBe(true);
    expect(typeof field.templateUrl).toBe('string');

    const pdfRes = await fetch(field.templateUrl);
    const buf = Buffer.from(await pdfRes.arrayBuffer());
    expect(buf.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('rejects a non-PDF template with a clean 400, not a 500', async () => {
    const res = await postMultipart(
      `/api/tenders/${tenderId}/document-fields`,
      { envelope: 'technical', key: 'bad_field', label: 'Bad Field' },
      { field: 'template', filename: 'template.txt', content: Buffer.from('not a pdf'), contentType: 'text/plain' },
      adminToken
    );
    expect(res.status).toBe(400);
  });

  it('a generator can upload a document for a field, and it shows up in their own status view', async () => {
    const fieldRes = await postMultipart(`/api/tenders/${tenderId}/document-fields`, { envelope: 'technical', key: 'upload_target', label: 'Upload Target' }, null, adminToken);
    expect(fieldRes.status).toBe(200);
    const fieldId = fieldRes.body.id;

    const uploadRes = await postMultipart(
      `/api/tenders/${tenderId}/document-fields/${fieldId}/upload`,
      {},
      { field: 'file', filename: 'my-document.pdf', content: pdfBuffer(), contentType: 'application/pdf' },
      generatorToken
    );
    expect(uploadRes.status).toBe(200);

    const mine = await get(`/api/tenders/${tenderId}/documents/mine`, generatorToken);
    expect(mine.status).toBe(200);
    const doc = mine.body.documents.find((d: { fieldId: number }) => d.fieldId === fieldId);
    expect(doc.uploaded).toBe(true);
    expect(doc.originalFilename).toBe('my-document.pdf');
    expect(typeof doc.downloadUrl).toBe('string');
  });

  it('re-uploading the same field replaces the previous upload rather than creating a duplicate', async () => {
    const fieldRes = await postMultipart(`/api/tenders/${tenderId}/document-fields`, { envelope: 'technical', key: 'replace_target', label: 'Replace Target' }, null, adminToken);
    const fieldId = fieldRes.body.id;

    await postMultipart(`/api/tenders/${tenderId}/document-fields/${fieldId}/upload`, {}, { field: 'file', filename: 'v1.pdf', content: pdfBuffer(), contentType: 'application/pdf' }, generatorToken);
    await postMultipart(`/api/tenders/${tenderId}/document-fields/${fieldId}/upload`, {}, { field: 'file', filename: 'v2.pdf', content: pdfBuffer(), contentType: 'application/pdf' }, generatorToken);

    const count = await TenderDocumentUpload.count({ where: { fieldId, organizationId: generatorOrgId } });
    expect(count).toBe(1);

    const mine = await get(`/api/tenders/${tenderId}/documents/mine`, generatorToken);
    const doc = mine.body.documents.find((d: { fieldId: number }) => d.fieldId === fieldId);
    expect(doc.originalFilename).toBe('v2.pdf');
  });

  it('a generator cannot upload before their invitation is accepted', async () => {
    const pendingGen = await Organization.create({ type: 'generator', name: 'Pending Gen', contactEmail: `pending-gen-${Date.now()}@test.local`, contactPhone: '9000000003' });
    createdOrgIds.push(pendingGen.id);
    const pendingToken = await signOrgToken({ organizationId: pendingGen.id, type: 'generator' });
    await TenderInvitation.create({ tenderId, organizationId: pendingGen.id, status: 'invited' });

    const fieldRes = await postMultipart(`/api/tenders/${tenderId}/document-fields`, { envelope: 'technical', key: 'gated_field', label: 'Gated Field' }, null, adminToken);
    const fieldId = fieldRes.body.id;

    const res = await postMultipart(`/api/tenders/${tenderId}/document-fields/${fieldId}/upload`, {}, { field: 'file', filename: 'x.pdf', content: pdfBuffer(), contentType: 'application/pdf' }, pendingToken);
    expect(res.status).toBe(403);
  });

  it('only admin organizations can review a generator\'s uploaded documents — the owning buyer has no visibility here', async () => {
    const buyerReview = await get(`/api/tenders/${tenderId}/documents/${generatorOrgId}`, buyerToken);
    expect(buyerReview.status).toBe(403);

    const genReview = await get(`/api/tenders/${tenderId}/documents/${generatorOrgId}`, generatorToken);
    expect(genReview.status).toBe(403);
  });

  it('rejects document review (409) before the technical envelope\'s opening ceremony has run for this tender', async () => {
    const review = await get(`/api/tenders/${tenderId}/documents/${generatorOrgId}`, adminToken);
    expect(review.status).toBe(409);
  });

  it('allows an admin to review a specific generator\'s uploaded documents once the technical ceremony has run', async () => {
    await VettingOpeningAttestation.create({
      tenderRef: String(tenderId),
      envelope: 'technical',
      openedSetHash: 'test-opened-set-hash',
      shareFingerprint1: 'test-fingerprint-1',
      shareFingerprint2: 'test-fingerprint-2',
      emergencyJustification: null,
    });

    const review = await get(`/api/tenders/${tenderId}/documents/${generatorOrgId}`, adminToken);
    expect(review.status).toBe(200);
    expect(review.body.documents.some((d: { uploaded: boolean }) => d.uploaded)).toBe(true);
  });

  it('deleting a field also removes any uploads made against it', async () => {
    const fieldRes = await postMultipart(`/api/tenders/${tenderId}/document-fields`, { envelope: 'technical', key: 'doomed_field', label: 'Doomed Field' }, null, adminToken);
    const fieldId = fieldRes.body.id;
    await postMultipart(`/api/tenders/${tenderId}/document-fields/${fieldId}/upload`, {}, { field: 'file', filename: 'x.pdf', content: pdfBuffer(), contentType: 'application/pdf' }, generatorToken);

    const delRes = await fetch(`${baseUrl}/api/tenders/${tenderId}/document-fields/${fieldId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${adminToken}` } });
    expect(delRes.status).toBe(200);

    const remainingField = await TenderDocumentField.findByPk(fieldId);
    expect(remainingField).toBeNull();
    const remainingUpload = await TenderDocumentUpload.findOne({ where: { fieldId } });
    expect(remainingUpload).toBeNull();
  });
});
