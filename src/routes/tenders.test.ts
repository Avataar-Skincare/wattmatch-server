import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import { Organization } from '../models/Organization.js';
import { Tender } from '../models/Tender.js';
import { TenderInvitation } from '../models/TenderInvitation.js';
import { Payment } from '../models/Payment.js';
import { Auction } from '../models/Auction.js';
import { signOrgToken } from '../lib/orgAuth.js';

let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let buyerOrgId: number;
let buyerToken: string;
let tenderId: number;

const createdOrgIds: number[] = [];

beforeAll(async () => {
  const { default: tendersRouter } = await import('./tenders.js');
  app = express();
  app.use(express.json());
  app.use('/api', tendersRouter);
  // Same JSON error-handling fix payments.test.ts already applies — without it an unhandled error
  // renders as Express's default HTML page and every subsequent assertion fails on JSON.parse
  // instead of on the actual thing under test.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Internal error' });
  });

  server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  const buyer = await Organization.create({ type: 'buyer', name: 'Enroll Test Buyer', contactEmail: `enroll-test-buyer-${Date.now()}@test.local`, contactPhone: '9000000000' });
  buyerOrgId = buyer.id;
  buyerToken = await signOrgToken({ organizationId: buyer.id, type: 'buyer' });
  createdOrgIds.push(buyer.id);

  const tender = await Tender.create({ buyerOrgId, title: `Enroll test tender ${Date.now()}`, requiredCapacityMw: '5' });
  tenderId = tender.id;
});

afterAll(async () => {
  await TenderInvitation.destroy({ where: { tenderId } });
  await Payment.destroy({ where: { tenderId } });
  await Tender.destroy({ where: { id: tenderId } });
  for (const id of createdOrgIds) await Organization.destroy({ where: { id } });
  await new Promise((resolve) => server.close(resolve));
});

afterEach(async () => {
  await TenderInvitation.destroy({ where: { tenderId } });
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

async function payRfsDocument(email: string, mobile?: string) {
  const payment = await Payment.create({
    purpose: 'rfs_document',
    tenderId,
    organizationId: null,
    payerName: 'Test Enroller',
    payerEmail: email,
    payerMobile: mobile ?? null,
    razorpayOrderId: `order_ENROLL_TEST_${Date.now()}_${Math.random()}`,
    amountPaise: 100,
    currency: 'INR',
    status: 'paid',
  });
  return payment;
}

describe('POST /tenders/:id/enroll', () => {
  it('rejects when the RfS Document fee has not been paid for this email', async () => {
    const email = `unpaid-${Date.now()}@test.local`;
    const res = await post(`/api/tenders/${tenderId}/enroll`, { email });
    expect(res.status).toBe(402);
  });

  it('auto-creates an account, emails credentials, enrolls, and returns a usable token when the caller has no existing account', async () => {
    const email = `newgen-${Date.now()}@test.local`;
    await payRfsDocument(email, '9876543210');

    const res = await post(`/api/tenders/${tenderId}/enroll`, { email });
    expect(res.status).toBe(200);
    expect(res.body.accountCreated).toBe(true);
    expect(typeof res.body.token).toBe('string');
    expect(res.body.status).toBe('accepted');

    const org = await Organization.findOne({ where: { contactEmail: email } });
    expect(org).not.toBeNull();
    expect(org!.type).toBe('generator');
    expect(org!.contactPhone).toBe('9876543210'); // pulled from the payment's payerMobile column
    createdOrgIds.push(org!.id);

    const invitation = await TenderInvitation.findOne({ where: { tenderId, organizationId: org!.id } });
    expect(invitation).not.toBeNull();
    expect(invitation!.status).toBe('accepted');
  });

  it('falls back to the request body contactPhone when the payment has no payerMobile', async () => {
    const email = `newgen2-${Date.now()}@test.local`;
    await payRfsDocument(email); // no mobile at all

    const noPhone = await post(`/api/tenders/${tenderId}/enroll`, { email });
    expect(noPhone.status).toBe(400);

    const withPhone = await post(`/api/tenders/${tenderId}/enroll`, { email, contactPhone: '9123456780' });
    expect(withPhone.status).toBe(200);

    const org = await Organization.findOne({ where: { contactEmail: email } });
    expect(org!.contactPhone).toBe('9123456780');
    createdOrgIds.push(org!.id);
  });

  it('rejects (409) rather than silently attaching to an account that already exists for that email', async () => {
    const email = `existing-${Date.now()}@test.local`;
    const existingOrg = await Organization.create({ type: 'generator', name: 'Already Registered', contactEmail: email, contactPhone: '9000000002' });
    createdOrgIds.push(existingOrg.id);
    await payRfsDocument(email, '9999999999');

    const res = await post(`/api/tenders/${tenderId}/enroll`, { email });
    expect(res.status).toBe(409);
    expect(res.body.accountExists).toBe(true);
  });
});

describe('GET /tenders/mine-as-buyer', () => {
  const createdTenderIds: number[] = [];
  const createdAuctionIds: number[] = [];

  afterAll(async () => {
    for (const id of createdAuctionIds) await Auction.destroy({ where: { id } });
    for (const id of createdTenderIds) await Tender.destroy({ where: { id } });
  });

  it('rejects with no token', async () => {
    const res = await get('/api/tenders/mine-as-buyer');
    expect(res.status).toBe(401);
  });

  it('returns an empty list for a buyer with no tenders', async () => {
    const freshBuyer = await Organization.create({ type: 'buyer', name: 'No Tenders Buyer', contactEmail: `no-tenders-buyer-${Date.now()}@test.local`, contactPhone: '9000000003' });
    createdOrgIds.push(freshBuyer.id);
    const freshToken = await signOrgToken({ organizationId: freshBuyer.id, type: 'buyer' });

    const res = await get('/api/tenders/mine-as-buyer', freshToken);
    expect(res.status).toBe(200);
    expect(res.body.tenders).toEqual([]);
  });

  it('lists only this buyer\'s own tenders, with auction info once promoted, and none of another buyer\'s', async () => {
    const otherBuyer = await Organization.create({ type: 'buyer', name: 'Other Buyer', contactEmail: `other-buyer-${Date.now()}@test.local`, contactPhone: '9000000004' });
    createdOrgIds.push(otherBuyer.id);

    const ownTenderNoAuction = await Tender.create({ buyerOrgId, title: `Mine, no auction ${Date.now()}`, requiredCapacityMw: '3' });
    createdTenderIds.push(ownTenderNoAuction.id);

    const ownTenderWithAuction = await Tender.create({ buyerOrgId, title: `Mine, promoted ${Date.now()}`, requiredCapacityMw: '4' });
    createdTenderIds.push(ownTenderWithAuction.id);
    const auction = await Auction.create({
      title: `Auction for ${ownTenderWithAuction.id}`,
      status: 'live',
      openingBid: '10.0000',
      windowSeconds: 480,
      maxAutoExtensions: 8,
      minUndercut: '0.01',
      tenderRef: ownTenderWithAuction.id,
    });
    createdAuctionIds.push(auction.id);

    const otherTender = await Tender.create({ buyerOrgId: otherBuyer.id, title: `Not mine ${Date.now()}`, requiredCapacityMw: '9' });
    createdTenderIds.push(otherTender.id);

    const res = await get('/api/tenders/mine-as-buyer', buyerToken);
    expect(res.status).toBe(200);
    const ids = res.body.tenders.map((t: { id: number }) => t.id);
    expect(ids).toContain(ownTenderNoAuction.id);
    expect(ids).toContain(ownTenderWithAuction.id);
    expect(ids).not.toContain(otherTender.id);

    const withAuction = res.body.tenders.find((t: { id: number }) => t.id === ownTenderWithAuction.id);
    expect(withAuction.auction).toEqual({ id: auction.id, status: 'live' });

    const withoutAuction = res.body.tenders.find((t: { id: number }) => t.id === ownTenderNoAuction.id);
    expect(withoutAuction.auction).toBeNull();
  });
});
