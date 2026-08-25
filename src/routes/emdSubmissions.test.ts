import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { Organization } from '../models/Organization.js';
import { Tender } from '../models/Tender.js';
import { TenderInvitation } from '../models/TenderInvitation.js';
import { EmdSubmission } from '../models/EmdSubmission.js';
import { signOrgToken } from '../lib/orgAuth.js';

let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let buyerOrgId: number;
let adminToken: string;
let generatorOrgId: number;
let generatorToken: string;
let tenderId: number;

const createdOrgIds: number[] = [];

beforeAll(async () => {
  const { default: emdSubmissionsRouter } = await import('./emdSubmissions.js');
  app = express();
  app.use(express.json());
  app.use('/api', emdSubmissionsRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Internal error' });
  });

  server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  const buyer = await Organization.create({ type: 'buyer', name: 'EMD Test Buyer', contactEmail: `emd-buyer-${Date.now()}@test.local`, contactPhone: '9000000000' });
  buyerOrgId = buyer.id;
  createdOrgIds.push(buyer.id);

  const admin = await Organization.create({ type: 'admin', name: 'EMD Test Admin', contactEmail: `emd-admin-${Date.now()}@test.local`, contactPhone: '9000000004' });
  adminToken = await signOrgToken({ organizationId: admin.id, type: 'admin' });
  createdOrgIds.push(admin.id);

  const generator = await Organization.create({ type: 'generator', name: 'EMD Test Generator', contactEmail: `emd-gen-${Date.now()}@test.local`, contactPhone: '9000000001' });
  generatorOrgId = generator.id;
  generatorToken = await signOrgToken({ organizationId: generator.id, type: 'generator' });
  createdOrgIds.push(generator.id);

  const tender = await Tender.create({ buyerOrgId, title: `EMD test tender ${Date.now()}`, requiredCapacityMw: '5' });
  tenderId = tender.id;
  await TenderInvitation.create({ tenderId, organizationId: generatorOrgId, status: 'accepted' });
});

afterAll(async () => {
  await EmdSubmission.destroy({ where: { tenderId } });
  await TenderInvitation.destroy({ where: { tenderId } });
  await Tender.destroy({ where: { id: tenderId } });
  for (const id of createdOrgIds) await Organization.destroy({ where: { id } });
  await new Promise((resolve) => server.close(resolve));
});

function pdfBuffer(): Buffer {
  return Buffer.from('%PDF-1.4\n%fake test bank guarantee\n');
}

const VALID_FIELDS = {
  bankName: 'Test Bank of India',
  guaranteeNumber: 'BG-0001',
  amountPaise: '10000000',
  validUpto: '2027-01-01',
  returnRecipientName: 'Test Generator Co',
  returnAddressLine: '123 Solar Street',
  returnCity: 'Delhi',
  returnState: 'Delhi',
  returnPincode: '110021',
  returnPhone: '9000000001',
};

async function submitEmd(fields: Record<string, string>, file: Buffer | null, token?: string) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file) form.append('document', new Blob([new Uint8Array(file)], { type: 'application/pdf' }), 'bg.pdf');

  const res = await fetch(`${baseUrl}/api/tenders/${tenderId}/emd-submission`, {
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

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

describe('emdSubmissions routes', () => {
  it('rejects a submission without a generator token', async () => {
    const res = await submitEmd(VALID_FIELDS, pdfBuffer());
    expect(res.status).toBe(401);
  });

  it('rejects a submission with no accepted invitation', async () => {
    const otherGen = await Organization.create({ type: 'generator', name: 'Uninvited Gen', contactEmail: `uninvited-${Date.now()}@test.local`, contactPhone: '9000000009' });
    createdOrgIds.push(otherGen.id);
    const otherToken = await signOrgToken({ organizationId: otherGen.id, type: 'generator' });

    const res = await submitEmd(VALID_FIELDS, pdfBuffer(), otherToken);
    expect(res.status).toBe(403);
  });

  it('rejects a submission with no file attached', async () => {
    const res = await submitEmd(VALID_FIELDS, null, generatorToken);
    expect(res.status).toBe(400);
  });

  it('rejects a submission with a non-PDF file', async () => {
    const form = new FormData();
    for (const [k, v] of Object.entries(VALID_FIELDS)) form.append(k, v);
    form.append('document', new Blob([new Uint8Array(Buffer.from('not a pdf'))], { type: 'text/plain' }), 'bg.txt');
    const res = await fetch(`${baseUrl}/api/tenders/${tenderId}/emd-submission`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${generatorToken}` },
      body: form,
    });
    expect(res.status).toBe(400);
  });

  it('accepts a submission, and admin can see it in the tender\'s EMD list', async () => {
    const res = await submitEmd(VALID_FIELDS, pdfBuffer(), generatorToken);
    expect(res.status).toBe(200);

    const mine = await get(`/api/tenders/${tenderId}/emd-submission/mine`, generatorToken);
    expect(mine.status).toBe(200);
    expect(mine.body.submission.status).toBe('submitted');
    expect(mine.body.submission.bankName).toBe('Test Bank of India');

    const list = await get(`/api/tenders/${tenderId}/emd-submissions`, adminToken);
    expect(list.status).toBe(200);
    expect(list.body.submissions).toHaveLength(1);
    expect(list.body.submissions[0].organizationId).toBe(generatorOrgId);
    expect(list.body.submissions[0].documentUrl).toBeTruthy();
  });

  it('a generator can replace their submission while still \'submitted\'', async () => {
    const res = await submitEmd({ ...VALID_FIELDS, bankName: 'Replacement Bank' }, pdfBuffer(), generatorToken);
    expect(res.status).toBe(200);

    const mine = await get(`/api/tenders/${tenderId}/emd-submission/mine`, generatorToken);
    expect(mine.body.submission.bankName).toBe('Replacement Bank');
  });

  it('a non-admin cannot list submissions or resolve one', async () => {
    const list = await get(`/api/tenders/${tenderId}/emd-submissions`, generatorToken);
    expect(list.status).toBe(403);

    const release = await post(`/api/tenders/${tenderId}/emd-submissions/${generatorOrgId}/release`, { reason: 'test' }, generatorToken);
    expect(release.status).toBe(403);
  });

  it('rejects release/invoke without a reason', async () => {
    const res = await post(`/api/tenders/${tenderId}/emd-submissions/${generatorOrgId}/release`, {}, adminToken);
    expect(res.status).toBe(400);
  });

  it('admin releases the EMD, after which it cannot be replaced or resolved again', async () => {
    const release = await post(
      `/api/tenders/${tenderId}/emd-submissions/${generatorOrgId}/release`,
      { reason: 'Not approved at technical stage', dispatchReference: 'SPEEDPOST-123' },
      adminToken
    );
    expect(release.status).toBe(200);

    const mine = await get(`/api/tenders/${tenderId}/emd-submission/mine`, generatorToken);
    expect(mine.body.submission.status).toBe('released');
    expect(mine.body.submission.dispatchReference).toBe('SPEEDPOST-123');

    const secondRelease = await post(`/api/tenders/${tenderId}/emd-submissions/${generatorOrgId}/release`, { reason: 'again' }, adminToken);
    expect(secondRelease.status).toBe(409);

    const replace = await submitEmd(VALID_FIELDS, pdfBuffer(), generatorToken);
    expect(replace.status).toBe(409);
  });

  it('returns 404 resolving an EMD that was never submitted', async () => {
    const otherGen = await Organization.create({ type: 'generator', name: 'No EMD Gen', contactEmail: `no-emd-${Date.now()}@test.local`, contactPhone: '9000000008' });
    createdOrgIds.push(otherGen.id);

    const res = await post(`/api/tenders/${tenderId}/emd-submissions/${otherGen.id}/invoke`, { reason: 'never submitted' }, adminToken);
    expect(res.status).toBe(404);
  });

  it('admin can invoke a different generator\'s EMD', async () => {
    const generator2 = await Organization.create({ type: 'generator', name: 'EMD Test Generator 2', contactEmail: `emd-gen2-${Date.now()}@test.local`, contactPhone: '9000000002' });
    createdOrgIds.push(generator2.id);
    const generator2Token = await signOrgToken({ organizationId: generator2.id, type: 'generator' });
    await TenderInvitation.create({ tenderId, organizationId: generator2.id, status: 'accepted' });

    const submit = await submitEmd(VALID_FIELDS, pdfBuffer(), generator2Token);
    expect(submit.status).toBe(200);

    const invoke = await post(`/api/tenders/${tenderId}/emd-submissions/${generator2.id}/invoke`, { reason: 'Won then backed out' }, adminToken);
    expect(invoke.status).toBe(200);

    const list = await get(`/api/tenders/${tenderId}/emd-submissions`, adminToken);
    const row = list.body.submissions.find((s: { organizationId: number }) => s.organizationId === generator2.id);
    expect(row.status).toBe('invoked');
    expect(row.resolvedReason).toBe('Won then backed out');
  });
});
