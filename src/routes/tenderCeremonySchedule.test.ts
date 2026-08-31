import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import { Organization } from '../models/Organization.js';
import { Tender } from '../models/Tender.js';
import { VettingOpeningAttestation } from '../models/VettingOpeningAttestation.js';
import { signOrgToken } from '../lib/orgAuth.js';
import { redis } from '../lib/redis.js';
import { escrowKey } from './vettingCustodian.js';

let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let buyerOrgId: number;
let adminOrgId: number;
let adminToken: string;

const createdOrgIds: number[] = [];

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

  const buyer = await Organization.create({ type: 'buyer', name: 'Ceremony Schedule Test Buyer', contactEmail: `ceremony-sched-buyer-${Date.now()}@test.local`, contactPhone: '9000000030' });
  buyerOrgId = buyer.id;
  const admin = await Organization.create({ type: 'admin', name: 'Ceremony Schedule Test Admin', contactEmail: `ceremony-sched-admin-${Date.now()}@test.local`, contactPhone: '9000000031' });
  adminOrgId = admin.id;
  createdOrgIds.push(buyer.id, admin.id);
  adminToken = await signOrgToken({ organizationId: admin.id, type: 'admin' });
});

afterAll(async () => {
  for (const id of createdOrgIds) await Organization.destroy({ where: { id } });
  await new Promise((resolve) => server.close(resolve));
});

async function patch(path: string, body: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function makeTender(): Promise<{ id: number; deadline: Date; technical: Date; financial: Date }> {
  const deadline = new Date(Date.now() + 60 * 60 * 1000);
  const technical = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const financial = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const tender = await Tender.create({
    buyerOrgId,
    title: `Ceremony schedule test ${Date.now()}-${Math.random().toString(36).slice(2)}`,
    requiredCapacityMw: '1',
    bidSubmissionDeadline: deadline,
    technicalBidOpenAt: technical,
    financialBidOpenAt: financial,
  });
  return { id: tender.id, deadline, technical, financial };
}

const createdTenderIds: number[] = [];

afterEach(async () => {
  for (const id of createdTenderIds.splice(0)) {
    await VettingOpeningAttestation.destroy({ where: { tenderRef: String(id) } });
    await redis.del(escrowKey(id, 'technical'));
    await redis.del(escrowKey(id, 'financial'));
    await Tender.destroy({ where: { id } });
  }
});

describe('PATCH /tenders/:id/ceremony-schedule', () => {
  it('rejects with no token', async () => {
    const { id, deadline } = await makeTender();
    createdTenderIds.push(id);
    const res = await patch(`/api/tenders/${id}/ceremony-schedule`, {
      bidSubmissionDeadline: deadline.toISOString(),
      technicalBidOpenAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      financialBidOpenAt: new Date(Date.now() + 5 * 60 * 60 * 1000).toISOString(),
    });
    expect(res.status).toBe(401);
  });

  it('lets admin move all three dates when neither ceremony has started', async () => {
    const { id } = await makeTender();
    createdTenderIds.push(id);
    const newDeadline = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString();
    const newTechnical = new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString();
    const newFinancial = new Date(Date.now() + 11 * 60 * 60 * 1000).toISOString();
    const res = await patch(
      `/api/tenders/${id}/ceremony-schedule`,
      { bidSubmissionDeadline: newDeadline, technicalBidOpenAt: newTechnical, financialBidOpenAt: newFinancial },
      adminToken
    );
    expect(res.status).toBe(200);
    const tender = await Tender.findByPk(id);
    // MySQL's DATETIME column stores whole-second precision, not milliseconds — compare at that
    // granularity rather than expecting an exact millisecond match.
    expect(Math.floor(tender!.bidSubmissionDeadline!.getTime() / 1000)).toBe(Math.floor(new Date(newDeadline).getTime() / 1000));
    expect(Math.floor(tender!.technicalBidOpenAt!.getTime() / 1000)).toBe(Math.floor(new Date(newTechnical).getTime() / 1000));
    expect(Math.floor(tender!.financialBidOpenAt!.getTime() / 1000)).toBe(Math.floor(new Date(newFinancial).getTime() / 1000));
  });

  it('rejects financialBidOpenAt before technicalBidOpenAt', async () => {
    const { id, deadline } = await makeTender();
    createdTenderIds.push(id);
    const res = await patch(
      `/api/tenders/${id}/ceremony-schedule`,
      {
        bidSubmissionDeadline: deadline.toISOString(),
        technicalBidOpenAt: new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString(),
        financialBidOpenAt: new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString(),
      },
      adminToken
    );
    expect(res.status).toBe(400);
  });

  it('rejects technicalBidOpenAt at or before bidSubmissionDeadline', async () => {
    const { id, deadline } = await makeTender();
    createdTenderIds.push(id);
    // A full second before the deadline, not exactly equal to it — avoids the MySQL DATETIME
    // whole-second-truncation ambiguity at an exact boundary value (see the route's own comment).
    const res = await patch(
      `/api/tenders/${id}/ceremony-schedule`,
      {
        bidSubmissionDeadline: deadline.toISOString(),
        technicalBidOpenAt: new Date(deadline.getTime() - 1000).toISOString(),
        financialBidOpenAt: new Date(Date.now() + 10 * 60 * 60 * 1000).toISOString(),
      },
      adminToken
    );
    expect(res.status).toBe(400);
  });

  it('blocks changing technicalBidOpenAt once that envelope\'s ceremony is fully attested', async () => {
    const { id, deadline } = await makeTender();
    createdTenderIds.push(id);
    await VettingOpeningAttestation.create({
      tenderRef: String(id),
      envelope: 'technical',
      openedSetHash: 'test-hash',
      shareFingerprint1: 'fp1',
      shareFingerprint2: 'fp2',
    });

    const res = await patch(
      `/api/tenders/${id}/ceremony-schedule`,
      {
        bidSubmissionDeadline: deadline.toISOString(),
        technicalBidOpenAt: new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString(),
        financialBidOpenAt: new Date(Date.now() + 21 * 60 * 60 * 1000).toISOString(),
      },
      adminToken
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already been completed/);
  });

  it('blocks changing bidSubmissionDeadline once the technical ceremony is fully attested', async () => {
    const { id, technical, financial } = await makeTender();
    createdTenderIds.push(id);
    await VettingOpeningAttestation.create({
      tenderRef: String(id),
      envelope: 'technical',
      openedSetHash: 'test-hash',
      shareFingerprint1: 'fp1',
      shareFingerprint2: 'fp2',
    });

    // Deadline moved later — technical/financial left exactly as they were. bidSubmissionDeadline
    // shares the 'technical' guard precisely so this can't slip through: letting the deadline move
    // after the technical envelope already opened would let a new bid in after everyone else's were
    // supposed to be final.
    const res = await patch(
      `/api/tenders/${id}/ceremony-schedule`,
      {
        bidSubmissionDeadline: new Date(Date.now() + 90 * 60 * 1000).toISOString(),
        technicalBidOpenAt: technical.toISOString(),
        financialBidOpenAt: financial.toISOString(),
      },
      adminToken
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already been completed/);
  });

  it('allows changing the OTHER envelope\'s date even when one is already completed', async () => {
    const { id, deadline, technical } = await makeTender();
    createdTenderIds.push(id);
    await VettingOpeningAttestation.create({
      tenderRef: String(id),
      envelope: 'technical',
      openedSetHash: 'test-hash',
      shareFingerprint1: 'fp1',
      shareFingerprint2: 'fp2',
    });

    const newFinancial = new Date(Date.now() + 30 * 60 * 60 * 1000).toISOString();
    const res = await patch(
      `/api/tenders/${id}/ceremony-schedule`,
      { bidSubmissionDeadline: deadline.toISOString(), technicalBidOpenAt: technical.toISOString(), financialBidOpenAt: newFinancial },
      adminToken
    );
    expect(res.status).toBe(200);
  });

  it('blocks changing a date once a custodian has escrowed their share (ceremony mid-flight)', async () => {
    const { id, deadline } = await makeTender();
    createdTenderIds.push(id);
    await redis.set(escrowKey(id, 'technical'), JSON.stringify({ firstCustodianId: 1, encryptedShare: 'x' }), 'PX', 60_000);

    const res = await patch(
      `/api/tenders/${id}/ceremony-schedule`,
      {
        bidSubmissionDeadline: deadline.toISOString(),
        technicalBidOpenAt: new Date(Date.now() + 20 * 60 * 60 * 1000).toISOString(),
        financialBidOpenAt: new Date(Date.now() + 21 * 60 * 60 * 1000).toISOString(),
      },
      adminToken
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/already in progress/);
  });

  it('does not block re-submitting the SAME already-completed dates unchanged', async () => {
    const { id, deadline, technical, financial } = await makeTender();
    createdTenderIds.push(id);
    await VettingOpeningAttestation.create({
      tenderRef: String(id),
      envelope: 'technical',
      openedSetHash: 'test-hash',
      shareFingerprint1: 'fp1',
      shareFingerprint2: 'fp2',
    });

    // Same values for all three fields — technical (and the deadline tied to it) are untouched
    // (even though completed), only a genuine change should ever hit the completed/in-progress guard.
    const res = await patch(
      `/api/tenders/${id}/ceremony-schedule`,
      { bidSubmissionDeadline: deadline.toISOString(), technicalBidOpenAt: technical.toISOString(), financialBidOpenAt: financial.toISOString() },
      adminToken
    );
    expect(res.status).toBe(200);
  });
});
