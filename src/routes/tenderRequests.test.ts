import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import { Organization } from '../models/Organization.js';
import { Tender } from '../models/Tender.js';
import { TenderRequest } from '../models/TenderRequest.js';
import { TenderInvitation } from '../models/TenderInvitation.js';
import { TenderDocumentField } from '../models/TenderDocumentField.js';
import { TenderDocumentUpload } from '../models/TenderDocumentUpload.js';
import { signOrgToken } from '../lib/orgAuth.js';

let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let buyerOrgId: number;
let buyerToken: string;
let adminOrgId: number;
let adminToken: string;

const createdOrgIds: number[] = [];
const createdTenderIds: number[] = [];

beforeAll(async () => {
  const { default: tendersRouter } = await import('./tenders.js');
  app = express();
  app.use(express.json());
  app.use('/api', tendersRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Internal error' });
  });

  server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  const buyer = await Organization.create({ type: 'buyer', name: 'Request Test Buyer', contactEmail: `request-buyer-${Date.now()}@test.local`, contactPhone: '9000000000' });
  buyerOrgId = buyer.id;
  buyerToken = await signOrgToken({ organizationId: buyer.id, type: 'buyer' });
  createdOrgIds.push(buyer.id);

  const admin = await Organization.create({ type: 'admin', name: 'Request Test Admin', contactEmail: `request-admin-${Date.now()}@test.local`, contactPhone: '9000000001' });
  adminOrgId = admin.id;
  adminToken = await signOrgToken({ organizationId: admin.id, type: 'admin' });
  createdOrgIds.push(admin.id);
});

afterAll(async () => {
  for (const id of createdTenderIds) {
    await TenderInvitation.destroy({ where: { tenderId: id } });
    await TenderDocumentUpload.destroy({ where: { tenderId: id } });
    await TenderDocumentField.destroy({ where: { tenderId: id } });
    await TenderRequest.destroy({ where: { tenderId: id } });
    await Tender.destroy({ where: { id } });
  }
  for (const id of createdOrgIds) await Organization.destroy({ where: { id } });
  await new Promise((resolve) => server.close(resolve));
});

afterEach(async () => {
  await TenderRequest.destroy({ where: { buyerOrgId, tenderId: null } });
});

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(path: string, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, body: await res.json() };
}

const pricing = { rfsDocumentFeePaise: 500, bidProcessingFeePaise: 1000, emdAmountPaise: 200000, successChargePaise: 5000 };

describe('tender requests + admin-only tender creation', () => {
  it('a buyer can submit a request, and see it in their own list', async () => {
    const res = await post('/api/tender-requests', { title: 'Request A', requiredCapacityMw: 10 }, buyerToken);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending');

    const mine = await get('/api/tender-requests/mine', buyerToken);
    expect(mine.status).toBe(200);
    const found = mine.body.requests.find((r: { id: number }) => r.id === res.body.id);
    expect(found).toBeTruthy();
    expect(found.tenderId).toBeNull();
  });

  it('a generator cannot submit a tender request', async () => {
    const gen = await Organization.create({ type: 'generator', name: 'Req Gen', contactEmail: `req-gen-${Date.now()}@test.local`, contactPhone: '9000000002' });
    createdOrgIds.push(gen.id);
    const genToken = await signOrgToken({ organizationId: gen.id, type: 'generator' });

    const res = await post('/api/tender-requests', { title: 'Should fail', requiredCapacityMw: 1 }, genToken);
    expect(res.status).toBe(403);
  });

  it('only an admin can list pending requests', async () => {
    const asBuyer = await get('/api/tender-requests', buyerToken);
    expect(asBuyer.status).toBe(403);

    const asAdmin = await get('/api/tender-requests', adminToken);
    expect(asAdmin.status).toBe(200);
  });

  it('admin converts a pending request into a real, priced tender', async () => {
    const reqRes = await post('/api/tender-requests', { title: 'Convert Me', requiredCapacityMw: 8 }, buyerToken);
    const tenderRequestId = reqRes.body.id;

    const tenderRes = await post('/api/tenders', { title: 'Convert Me — final', requiredCapacityMw: 8, tenderRequestId, ...pricing }, adminToken);
    expect(tenderRes.status).toBe(200);
    createdTenderIds.push(tenderRes.body.tenderId);

    const tender = await Tender.findByPk(tenderRes.body.tenderId);
    expect(tender!.buyerOrgId).toBe(buyerOrgId);
    expect(tender!.rfsDocumentFeePaise).toBe(500);
    expect(tender!.bidProcessingFeePaise).toBe(1000);
    expect(tender!.emdAmountPaise).toBe(200000);
    expect(tender!.successChargePaise).toBe(5000);

    const request = await TenderRequest.findByPk(tenderRequestId);
    expect(request!.status).toBe('converted');
    expect(request!.tenderId).toBe(tenderRes.body.tenderId);
  });

  it('rejects converting the same request twice', async () => {
    const reqRes = await post('/api/tender-requests', { title: 'Convert Once', requiredCapacityMw: 3 }, buyerToken);
    const tenderRequestId = reqRes.body.id;

    const first = await post('/api/tenders', { title: 'First conversion', requiredCapacityMw: 3, tenderRequestId, ...pricing }, adminToken);
    expect(first.status).toBe(200);
    createdTenderIds.push(first.body.tenderId);

    const second = await post('/api/tenders', { title: 'Second conversion', requiredCapacityMw: 3, tenderRequestId, ...pricing }, adminToken);
    expect(second.status).toBe(409);
  });

  it('admin can create an ad-hoc tender with an explicit buyerOrgId, with no request involved', async () => {
    const res = await post('/api/tenders', { title: 'Ad hoc tender', requiredCapacityMw: 4, buyerOrgId, ...pricing }, adminToken);
    expect(res.status).toBe(200);
    createdTenderIds.push(res.body.tenderId);
  });

  it('rejects a buyerOrgId that does not refer to a real buyer', async () => {
    const res = await post('/api/tenders', { title: 'Bad buyer', requiredCapacityMw: 4, buyerOrgId: 999999999, ...pricing }, adminToken);
    expect(res.status).toBe(400);
  });

  it('a buyer token can no longer create a tender directly', async () => {
    const res = await post('/api/tenders', { title: 'Should fail', requiredCapacityMw: 4, buyerOrgId, ...pricing }, buyerToken);
    expect(res.status).toBe(403);
  });

  it('rejects a tender creation request missing pricing fields', async () => {
    const res = await post('/api/tenders', { title: 'No pricing', requiredCapacityMw: 4, buyerOrgId }, adminToken);
    expect(res.status).toBe(400);
  });
});
