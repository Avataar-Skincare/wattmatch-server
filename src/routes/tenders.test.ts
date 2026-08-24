import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import express from 'express';
import { Organization } from '../models/Organization.js';
import { Tender } from '../models/Tender.js';
import { TenderInvitation } from '../models/TenderInvitation.js';
import { Payment } from '../models/Payment.js';
import { signOrgToken } from '../lib/orgAuth.js';

let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let buyerOrgId: number;
let buyerToken: string;
let adminToken: string;
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

  const admin = await Organization.create({ type: 'admin', name: 'Enroll Test Admin', contactEmail: `enroll-test-admin-${Date.now()}@test.local`, contactPhone: '9000000001' });
  adminToken = await signOrgToken({ organizationId: admin.id, type: 'admin' });
  createdOrgIds.push(admin.id);

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

describe('POST /tenders/:id/invitations/:organizationId/settle-winner and declare-default', () => {
  async function makeWinner() {
    const org = await Organization.create({
      type: 'generator',
      name: 'Winner Org',
      contactEmail: `winner-${Date.now()}-${Math.random()}@test.local`,
      contactPhone: '9000000003',
    });
    createdOrgIds.push(org.id);
    await TenderInvitation.create({ tenderId, organizationId: org.id, status: 'accepted', emdOutcome: 'pending' });
    return org;
  }

  it('rejects settle-winner and declare-default (403) for a buyer token — this is admin-only, buyers have no operational role here', async () => {
    const org = await makeWinner();
    const settleRes = await post(`/api/tenders/${tenderId}/invitations/${org.id}/settle-winner`, {}, buyerToken);
    expect(settleRes.status).toBe(403);

    const defaultRes = await post(`/api/tenders/${tenderId}/invitations/${org.id}/declare-default`, {}, buyerToken);
    expect(defaultRes.status).toBe(403);

    const invitation = await TenderInvitation.findOne({ where: { tenderId, organizationId: org.id } });
    expect(invitation!.emdOutcome).toBe('pending'); // unchanged
  });

  it('rejects settle-winner (409) when the success charge has not been paid yet', async () => {
    const org = await makeWinner();
    const res = await post(`/api/tenders/${tenderId}/invitations/${org.id}/settle-winner`, {}, adminToken);
    expect(res.status).toBe(409);

    const invitation = await TenderInvitation.findOne({ where: { tenderId, organizationId: org.id } });
    expect(invitation!.emdOutcome).toBe('pending'); // unchanged
  });

  it('settle-winner succeeds, but leaves EMD outcome pending (not falsely "refunded") when no paid EMD payment exists to actually refund', async () => {
    const org = await makeWinner();
    await Payment.create({
      purpose: 'success_charge',
      tenderId,
      organizationId: org.id,
      razorpayOrderId: `order_SETTLE_TEST_${Date.now()}`,
      amountPaise: 100,
      currency: 'INR',
      status: 'paid',
    });
    // Deliberately no 'emd' Payment created — refundEmd's own guard against silently marking
    // "refunded" with nothing to actually refund kicks in (see emdOutcomeService.ts).

    const res = await post(`/api/tenders/${tenderId}/invitations/${org.id}/settle-winner`, {}, adminToken);
    expect(res.status).toBe(200); // settle-winner itself succeeds regardless of the refund attempt's own outcome
    expect(res.body.emdRefunded).toBe(false);

    const invitation = await TenderInvitation.findOne({ where: { tenderId, organizationId: org.id } });
    expect(invitation!.emdOutcome).toBe('pending');
  });

  it('settle-winner leaves EMD outcome pending when the EMD payment on file cannot actually be refunded by Razorpay', async () => {
    const org = await makeWinner();
    await Payment.create({
      purpose: 'success_charge',
      tenderId,
      organizationId: org.id,
      razorpayOrderId: `order_SETTLE_TEST_SC_${Date.now()}`,
      amountPaise: 100,
      currency: 'INR',
      status: 'paid',
    });
    // A synthetic razorpayPaymentId can never actually be refunded by Razorpay's real API — same
    // limitation payments.test.ts's own refund-rejection test documents (there's no way to get a
    // genuinely refundable payment without a real checkout). This proves refundEmd doesn't lie
    // about the outcome when the real refund call fails.
    await Payment.create({
      purpose: 'emd',
      tenderId,
      organizationId: org.id,
      razorpayOrderId: `order_SETTLE_TEST_EMD_${Date.now()}`,
      razorpayPaymentId: `pay_FAKE_${Date.now()}`,
      amountPaise: 100,
      currency: 'INR',
      status: 'paid',
    });

    const res = await post(`/api/tenders/${tenderId}/invitations/${org.id}/settle-winner`, {}, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.emdRefunded).toBe(false);

    const invitation = await TenderInvitation.findOne({ where: { tenderId, organizationId: org.id } });
    expect(invitation!.emdOutcome).toBe('pending');
  });

  it('forfeits the EMD via declare-default when the winner never pays', async () => {
    const org = await makeWinner();
    const res = await post(`/api/tenders/${tenderId}/invitations/${org.id}/declare-default`, {}, adminToken);
    expect(res.status).toBe(200);

    const invitation = await TenderInvitation.findOne({ where: { tenderId, organizationId: org.id } });
    expect(invitation!.emdOutcome).toBe('forfeited');
  });

  it('refuses declare-default (409) once the success charge has actually been paid', async () => {
    const org = await makeWinner();
    await Payment.create({
      purpose: 'success_charge',
      tenderId,
      organizationId: org.id,
      razorpayOrderId: `order_DECLARE_TEST_${Date.now()}`,
      amountPaise: 100,
      currency: 'INR',
      status: 'paid',
    });

    const res = await post(`/api/tenders/${tenderId}/invitations/${org.id}/declare-default`, {}, adminToken);
    expect(res.status).toBe(409);

    const invitation = await TenderInvitation.findOne({ where: { tenderId, organizationId: org.id } });
    expect(invitation!.emdOutcome).toBe('pending'); // unchanged — not forfeited
  });
});
