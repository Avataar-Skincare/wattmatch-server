import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { Organization } from '../models/Organization.js';
import { Tender } from '../models/Tender.js';
import { VettingBid } from '../models/VettingBid.js';
import { VettingOpeningAttestation } from '../models/VettingOpeningAttestation.js';
import { Auction } from '../models/Auction.js';
import { signOrgToken } from '../lib/orgAuth.js';

// Previously had no test file at all (platform audit's M20 finding). The full end-to-end
// promote-to-auction path (real sealed-bid ceremony -> approved generator -> seeded auction ->
// rejecting a second promotion of the same tender) is already exercised thoroughly by
// pipelineIntegration.test.ts — this file covers the request-validation edge cases that test
// doesn't reach, without re-running an entire ceremony for each one.

let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let adminToken: string;

const createdOrgIds: number[] = [];
const createdTenderIds: number[] = [];
const createdBidIds: number[] = [];
const createdAttestationIds: number[] = [];
const createdAuctionIds: number[] = [];

beforeAll(async () => {
  const { default: vettingAuctionBridgeRouter } = await import('./vettingAuctionBridge.js');
  app = express();
  app.use(express.json());
  app.use('/api', vettingAuctionBridgeRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Internal error' });
  });

  server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  const admin = await Organization.create({
    type: 'admin', name: 'Test Admin', contactEmail: `bridge-admin-${Date.now()}@test.local`, contactPhone: '9000000030',
  });
  createdOrgIds.push(admin.id);
  adminToken = await signOrgToken({ organizationId: admin.id, type: 'admin' });
});

afterAll(async () => {
  for (const id of createdAuctionIds) await Auction.destroy({ where: { id } });
  for (const id of createdAttestationIds) await VettingOpeningAttestation.destroy({ where: { id } });
  for (const id of createdBidIds) await VettingBid.destroy({ where: { id } });
  for (const id of createdTenderIds) await Tender.destroy({ where: { id } });
  for (const id of createdOrgIds) await Organization.destroy({ where: { id } });
  await new Promise((resolve) => server.close(resolve));
});

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function makeBuyerAndTender(overrides: Partial<{ useLandedRate: boolean; equityValue: string | null; totalUnitsPerYear: string | null }> = {}) {
  const buyer = await Organization.create({
    type: 'buyer', name: 'Test Buyer', contactEmail: `bridge-buyer-${Date.now()}-${Math.random()}@test.local`, contactPhone: '9000000031',
  });
  createdOrgIds.push(buyer.id);
  const tender = await Tender.create({
    buyerOrgId: buyer.id,
    title: 'Bridge Test Tender',
    requiredCapacityMw: '5',
    useLandedRate: overrides.useLandedRate ?? false,
    equityValue: overrides.equityValue ?? null,
    totalUnitsPerYear: overrides.totalUnitsPerYear ?? null,
  });
  createdTenderIds.push(tender.id);
  return tender;
}

function futureIso(minutes = 5): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

describe('POST /vetting-bids/:tenderRef/promote-to-auction — request validation', () => {
  it('rejects a scheduledStartAt that is too soon', async () => {
    const tender = await makeBuyerAndTender();
    const res = await post(`/api/vetting-bids/${tender.id}/promote-to-auction`, { scheduledStartAt: new Date().toISOString() }, adminToken);
    expect(res.status).toBe(400);
  });

  it('rejects when the financial ceremony has not been run for this tender', async () => {
    const tender = await makeBuyerAndTender();
    const res = await post(`/api/vetting-bids/${tender.id}/promote-to-auction`, { scheduledStartAt: futureIso() }, adminToken);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/financial ceremony/i);
  });

  it('404s when the financial attestation exists but the tender itself does not', async () => {
    const bogusTenderRef = 999_555_111;
    const attestation = await VettingOpeningAttestation.create({
      tenderRef: String(bogusTenderRef),
      envelope: 'financial',
      openedSetHash: 'irrelevant',
      shareFingerprint1: 'a',
      shareFingerprint2: 'b',
    });
    createdAttestationIds.push(attestation.id);

    const res = await post(`/api/vetting-bids/${bogusTenderRef}/promote-to-auction`, { scheduledStartAt: futureIso() }, adminToken);
    expect(res.status).toBe(404);
  });

  it('rejects a landed-rate tender with no equityValue/totalUnitsPerYear set', async () => {
    const tender = await makeBuyerAndTender({ useLandedRate: true, equityValue: null, totalUnitsPerYear: null });
    const attestation = await VettingOpeningAttestation.create({
      tenderRef: String(tender.id),
      envelope: 'financial',
      openedSetHash: 'irrelevant',
      shareFingerprint1: 'a',
      shareFingerprint2: 'b',
    });
    createdAttestationIds.push(attestation.id);

    const res = await post(`/api/vetting-bids/${tender.id}/promote-to-auction`, { scheduledStartAt: futureIso() }, adminToken);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/equityValue/);
  });

  it('rejects when there are no approved generators to promote', async () => {
    const tender = await makeBuyerAndTender();
    const attestation = await VettingOpeningAttestation.create({
      tenderRef: String(tender.id),
      envelope: 'financial',
      openedSetHash: 'irrelevant',
      shareFingerprint1: 'a',
      shareFingerprint2: 'b',
    });
    createdAttestationIds.push(attestation.id);

    const res = await post(`/api/vetting-bids/${tender.id}/promote-to-auction`, { scheduledStartAt: futureIso() }, adminToken);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No approved generators/i);
  });

  it('a non-admin org cannot promote a tender', async () => {
    const buyer = await Organization.create({
      type: 'buyer', name: 'Non Admin', contactEmail: `bridge-nonadmin-${Date.now()}@test.local`, contactPhone: '9000000032',
    });
    createdOrgIds.push(buyer.id);
    const buyerToken = await signOrgToken({ organizationId: buyer.id, type: 'buyer' });
    const tender = await makeBuyerAndTender();

    const res = await post(`/api/vetting-bids/${tender.id}/promote-to-auction`, { scheduledStartAt: futureIso() }, buyerToken);
    expect(res.status).toBe(403);
  });

  it('rejects an invalid tenderRef', async () => {
    const res = await post('/api/vetting-bids/not-a-number/promote-to-auction', { scheduledStartAt: futureIso() }, adminToken);
    expect(res.status).toBe(400);
  });
});
