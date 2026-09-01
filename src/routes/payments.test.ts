import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import crypto from 'node:crypto';
import { Organization } from '../models/Organization.js';
import { Tender } from '../models/Tender.js';
import { Payment } from '../models/Payment.js';
import { signOrgToken } from '../lib/orgAuth.js';

// Real Razorpay test-mode credentials from .env are required for these tests — order creation
// makes a real (test-mode, free) API call, same as every other live check done for this module.
// Skipped automatically if they're not configured, rather than failing the whole suite for anyone
// running tests without payment credentials set up locally.
const hasRazorpayConfig = Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET && process.env.RAZORPAY_WEBHOOK_SECRET);

let app: express.Express;
let server: ReturnType<express.Express['listen']>;
let baseUrl: string;
let buyerOrgId: number;
let buyerToken: string;
let adminToken: string;
let tenderId: number;

const createdOrgIds: number[] = [];

beforeAll(async () => {
  const { default: paymentsRouter } = await import('./payments.js');
  app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as express.Request).rawBody = buf; } }));
  // Mirrors index.ts's own catch-all error handler — without this, an unhandled error (e.g. a real
  // 429 from Razorpay's test-mode API, which this file's rapid-fire order creation can genuinely
  // trigger) falls through to Express's default handler and comes back as an HTML error page
  // instead of JSON, breaking every test after it with a confusing "not valid JSON" failure that
  // has nothing to do with the actual route logic. Production already handles this correctly
  // (index.ts's own error middleware) — this closes the same gap in the test harness.
  app.use('/api', paymentsRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ success: false, error: err instanceof Error ? err.message : 'Internal error' });
  });

  // ONE shared server for the whole file rather than a fresh app.listen(0)/close() per request —
  // this file makes well over a dozen HTTP calls; there's no reason to pay ephemeral-port setup
  // cost for each one.
  server = app.listen(0);
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;

  const buyer = await Organization.create({ type: 'buyer', name: 'Payments Test Buyer', contactEmail: `payments-test-${Date.now()}@test.local`, contactPhone: '9000000000' });
  buyerOrgId = buyer.id;
  createdOrgIds.push(buyer.id);
  buyerToken = await signOrgToken({ organizationId: buyer.id, type: 'buyer' });

  const admin = await Organization.create({ type: 'admin', name: 'Payments Test Admin', contactEmail: `payments-test-admin-${Date.now()}@test.local`, contactPhone: '9000000001' });
  createdOrgIds.push(admin.id);
  adminToken = await signOrgToken({ organizationId: admin.id, type: 'admin' });

  const tender = await Tender.create({ buyerOrgId: buyer.id, title: `Payments test tender ${Date.now()}`, requiredCapacityMw: '5' });
  tenderId = tender.id;
});

afterAll(async () => {
  await Payment.destroy({ where: { tenderId } });
  await Tender.destroy({ where: { id: tenderId } });
  for (const id of createdOrgIds) await Organization.destroy({ where: { id } });
  await new Promise((resolve) => server.close(resolve));
});

// This file's order-creation calls hit Razorpay's REAL test-mode API (not a mock) — see the module
// comment. A small pacing delay before each call keeps this well-behaved test suite from tripping
// Razorpay's own rate limiting when run repeatedly in quick succession (observed directly: a real
// 429 from Razorpay, not a bug in this codebase — see the error-handling middleware comment above).
function paceRealApiCall(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 200));
}

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  await paceRealApiCall();
  const bodyString = JSON.stringify(body);
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: bodyString,
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    throw new Error(`Expected JSON from ${path} but got ${res.status}: ${text.slice(0, 300)}`);
  }
}

async function postRaw(path: string, bodyString: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: bodyString,
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    throw new Error(`Expected JSON from ${path} but got ${res.status}: ${text.slice(0, 300)}`);
  }
}

function signWebhook(bodyString: string): string {
  return crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET!).update(bodyString).digest('hex');
}

async function getJson(path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${baseUrl}${path}`, { headers });
  return { status: res.status, body: await res.json() };
}

// Stage 3's now-required structured fields (company/designation/mobile/isGenerator/consentGiven —
// see rfsDocumentOrderBodySchema) — spread into every rfs-document order call below so each test
// keeps exercising its own actual concern instead of tripping validation on unrelated fields.
const RFS_STAGE3_FIELDS = { company: 'Test Co', designation: 'CEO', mobile: '9999999999', isGenerator: false, consentGiven: true as const };

describe.runIf(hasRazorpayConfig)('payments routes', () => {
  it('rejects a client-supplied amount on the public rfs-document order route', async () => {
    const res = await postJson('/api/payment/orders/rfs-document', { tenderId, payerName: 'A', payerEmail: 'a@test.local', ...RFS_STAGE3_FIELDS, amount: 999999 });
    expect(res.status).toBe(400);
  });

  it('rejects an authenticated order request with no token', async () => {
    const res = await postJson('/api/payment/orders', { purpose: 'bid_processing', tenderId });
    expect(res.status).toBe(401);
  });

  it('creates a real order and never returns the key secret', async () => {
    const res = await postJson('/api/payment/orders/rfs-document', { tenderId, payerName: 'A', payerEmail: 'a@test.local', ...RFS_STAGE3_FIELDS });
    expect(res.status).toBe(200);
    expect(res.body.orderId).toMatch(/^order_/);
    expect(JSON.stringify(res.body)).not.toContain(process.env.RAZORPAY_KEY_SECRET);
  });

  it('an authenticated order records the caller\'s own organizationId, never a client-supplied one', async () => {
    const res = await postJson('/api/payment/orders', { purpose: 'bid_processing', tenderId }, { Authorization: `Bearer ${buyerToken}` });
    expect(res.status).toBe(200);
    const payment = await Payment.findOne({ where: { razorpayOrderId: res.body.orderId } });
    expect(payment!.organizationId).toBe(buyerOrgId);
  });

  it('a second order request for the same tender+purpose while the first is unpaid resumes that same order, not a new one', async () => {
    const scopedTender = await Tender.create({ buyerOrgId, title: `Payments dedup test tender ${Date.now()}`, requiredCapacityMw: '5' });
    try {
      const first = await postJson('/api/payment/orders', { purpose: 'bid_processing', tenderId: scopedTender.id }, { Authorization: `Bearer ${buyerToken}` });
      expect(first.status).toBe(200);

      const second = await postJson('/api/payment/orders', { purpose: 'bid_processing', tenderId: scopedTender.id }, { Authorization: `Bearer ${buyerToken}` });
      expect(second.status).toBe(200);
      expect(second.body.orderId).toBe(first.body.orderId);

      const paymentCount = await Payment.count({ where: { tenderId: scopedTender.id, organizationId: buyerOrgId, purpose: 'bid_processing' } });
      expect(paymentCount).toBe(1);
    } finally {
      await Payment.destroy({ where: { tenderId: scopedTender.id } });
      await Tender.destroy({ where: { id: scopedTender.id } });
    }
  });

  it('a further order request after the fee is already paid is rejected with 409, not a second charge', async () => {
    const scopedTender = await Tender.create({ buyerOrgId, title: `Payments dedup paid test tender ${Date.now()}`, requiredCapacityMw: '5' });
    try {
      const orderRes = await postJson('/api/payment/orders', { purpose: 'bid_processing', tenderId: scopedTender.id }, { Authorization: `Bearer ${buyerToken}` });
      expect(orderRes.status).toBe(200);

      const payload = {
        entity: 'event',
        event: 'payment.captured',
        payload: { payment: { entity: { id: `pay_TEST${Date.now()}`, order_id: orderRes.body.orderId } } },
      };
      const bodyString = JSON.stringify(payload);
      await postRaw('/api/payment/webhook', bodyString, { 'x-razorpay-signature': signWebhook(bodyString) });
      await new Promise((r) => setTimeout(r, 50));

      const again = await postJson('/api/payment/orders', { purpose: 'bid_processing', tenderId: scopedTender.id }, { Authorization: `Bearer ${buyerToken}` });
      expect(again.status).toBe(409);

      const paymentCount = await Payment.count({ where: { tenderId: scopedTender.id, organizationId: buyerOrgId, purpose: 'bid_processing' } });
      expect(paymentCount).toBe(1);
    } finally {
      await Payment.destroy({ where: { tenderId: scopedTender.id } });
      await Tender.destroy({ where: { id: scopedTender.id } });
    }
  });

  it('two genuinely concurrent order requests for the same tender+purpose+org create only one order, not two', async () => {
    // Regression test for the TOCTOU race the payment-order lock closes: without it, two requests
    // that both arrive before either's Payment.create() has landed can both pass the "no existing
    // order" dedup check and each mint a separate Razorpay order for the same fee.
    const scopedTender = await Tender.create({ buyerOrgId, title: `Payments concurrency test tender ${Date.now()}`, requiredCapacityMw: '5' });
    try {
      const [first, second] = await Promise.all([
        postJson('/api/payment/orders', { purpose: 'bid_processing', tenderId: scopedTender.id }, { Authorization: `Bearer ${buyerToken}` }),
        postJson('/api/payment/orders', { purpose: 'bid_processing', tenderId: scopedTender.id }, { Authorization: `Bearer ${buyerToken}` }),
      ]);

      const statuses = [first.status, second.status].sort();
      // Whichever request loses the lock gets a 409 asking it to retry, rather than silently
      // spawning a second order — exactly one of the two actually creates a payment.
      expect(statuses).toEqual([200, 409]);

      const paymentCount = await Payment.count({ where: { tenderId: scopedTender.id, organizationId: buyerOrgId, purpose: 'bid_processing' } });
      expect(paymentCount).toBe(1);
    } finally {
      await Payment.destroy({ where: { tenderId: scopedTender.id } });
      await Tender.destroy({ where: { id: scopedTender.id } });
    }
  });

  it('/verify rejects a tampered signature and marks the payment failed, then refuses a second attempt', async () => {
    const orderRes = await postJson('/api/payment/orders/rfs-document', { tenderId, payerName: 'B', payerEmail: 'b@test.local', ...RFS_STAGE3_FIELDS });
    const fakePaymentId = `pay_TEST${Date.now()}`;

    const badRes = await postJson('/api/payment/verify', {
      razorpayOrderId: orderRes.body.orderId,
      razorpayPaymentId: fakePaymentId,
      razorpaySignature: 'f'.repeat(64),
    });
    expect(badRes.status).toBe(400);

    const retryRes = await postJson('/api/payment/verify', {
      razorpayOrderId: orderRes.body.orderId,
      razorpayPaymentId: fakePaymentId,
      razorpaySignature: 'f'.repeat(64),
    });
    expect(retryRes.status).toBe(409);
  });

  it('/verify accepts a correctly signed callback and is idempotent on repeat', async () => {
    const orderRes = await postJson('/api/payment/orders/rfs-document', { tenderId, payerName: 'C', payerEmail: 'c@test.local', ...RFS_STAGE3_FIELDS });
    const fakePaymentId = `pay_TEST${Date.now()}`;
    const signature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET!).update(`${orderRes.body.orderId}|${fakePaymentId}`).digest('hex');

    const firstRes = await postJson('/api/payment/verify', { razorpayOrderId: orderRes.body.orderId, razorpayPaymentId: fakePaymentId, razorpaySignature: signature });
    expect(firstRes.status).toBe(200);

    const secondRes = await postJson('/api/payment/verify', { razorpayOrderId: orderRes.body.orderId, razorpayPaymentId: fakePaymentId, razorpaySignature: signature });
    expect(secondRes.status).toBe(200);
    expect(secondRes.body.status).toBe('paid');
  });

  it('webhook: valid payment.captured marks the order paid with no prior /verify call', async () => {
    const orderRes = await postJson('/api/payment/orders/rfs-document', { tenderId, payerName: 'D', payerEmail: 'd@test.local', ...RFS_STAGE3_FIELDS });
    const payload = {
      entity: 'event',
      event: 'payment.captured',
      payload: { payment: { entity: { id: `pay_TEST${Date.now()}`, order_id: orderRes.body.orderId } } },
    };
    const bodyString = JSON.stringify(payload);
    const res = await postRaw('/api/payment/webhook', bodyString, { 'x-razorpay-signature': signWebhook(bodyString) });
    expect(res.status).toBe(200);

    // Async post-response processing — give it a tick to complete before asserting DB state.
    await new Promise((r) => setTimeout(r, 50));
    const payment = await Payment.findOne({ where: { razorpayOrderId: orderRes.body.orderId } });
    expect(payment!.status).toBe('paid');
  });

  it('webhook: an invalid signature is rejected and fulfils nothing', async () => {
    const orderRes = await postJson('/api/payment/orders/rfs-document', { tenderId, payerName: 'E', payerEmail: 'e@test.local', ...RFS_STAGE3_FIELDS });
    const payload = {
      entity: 'event',
      event: 'payment.captured',
      payload: { payment: { entity: { id: `pay_TEST${Date.now()}`, order_id: orderRes.body.orderId } } },
    };
    const res = await postRaw('/api/payment/webhook', JSON.stringify(payload), { 'x-razorpay-signature': 'f'.repeat(64) });
    expect(res.status).toBe(400);

    const payment = await Payment.findOne({ where: { razorpayOrderId: orderRes.body.orderId } });
    expect(payment!.status).toBe('created');
  });

  it('webhook: duplicate payment.captured delivery does not double-fulfil', async () => {
    const orderRes = await postJson('/api/payment/orders/rfs-document', { tenderId, payerName: 'F', payerEmail: 'f@test.local', ...RFS_STAGE3_FIELDS });
    const payload = {
      entity: 'event',
      event: 'payment.captured',
      payload: { payment: { entity: { id: `pay_TEST${Date.now()}`, order_id: orderRes.body.orderId } } },
    };
    const bodyString = JSON.stringify(payload);
    const signature = signWebhook(bodyString);

    await postRaw('/api/payment/webhook', bodyString, { 'x-razorpay-signature': signature });
    await new Promise((r) => setTimeout(r, 50));
    await postRaw('/api/payment/webhook', bodyString, { 'x-razorpay-signature': signature });
    await new Promise((r) => setTimeout(r, 50));

    const payment = await Payment.findOne({ where: { razorpayOrderId: orderRes.body.orderId } });
    expect(payment!.status).toBe('paid');
  });

  it('webhook: payment.failed sets the correct status', async () => {
    const orderRes = await postJson('/api/payment/orders/rfs-document', { tenderId, payerName: 'G', payerEmail: 'g@test.local', ...RFS_STAGE3_FIELDS });
    const payload = {
      entity: 'event',
      event: 'payment.failed',
      payload: { payment: { entity: { id: `pay_TEST${Date.now()}`, order_id: orderRes.body.orderId } } },
    };
    const bodyString = JSON.stringify(payload);
    const res = await postRaw('/api/payment/webhook', bodyString, { 'x-razorpay-signature': signWebhook(bodyString) });
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 50));
    const payment = await Payment.findOne({ where: { razorpayOrderId: orderRes.body.orderId } });
    expect(payment!.status).toBe('failed');
  });

  it('refund and reconcile both reject with no token, and with a non-admin (buyer) token', async () => {
    const noTokenRefund = await postJson('/api/payment/1/refund', {});
    expect(noTokenRefund.status).toBe(401);
    const buyerRefund = await postJson('/api/payment/1/refund', {}, { Authorization: `Bearer ${buyerToken}` });
    expect(buyerRefund.status).toBe(403);

    const noTokenReconcile = await postJson('/api/payment/reconcile', {});
    expect(noTokenReconcile.status).toBe(401);
    const buyerReconcile = await postJson('/api/payment/reconcile', {}, { Authorization: `Bearer ${buyerToken}` });
    expect(buyerReconcile.status).toBe(403);
  });

  it('refund: rejects a payment that is not yet paid', async () => {
    const orderRes = await postJson('/api/payment/orders/rfs-document', { tenderId, payerName: 'H', payerEmail: 'h@test.local', ...RFS_STAGE3_FIELDS });
    const payment = await Payment.findOne({ where: { razorpayOrderId: orderRes.body.orderId } });

    const res = await postJson(`/api/payment/${payment!.id}/refund`, {}, { Authorization: `Bearer ${adminToken}` });
    expect(res.status).toBe(409);
  });

  it('refund: rejects an invalid body and a nonexistent payment id', async () => {
    const badBody = await postJson('/api/payment/1/refund', { amountPaise: -5 }, { Authorization: `Bearer ${adminToken}` });
    expect(badBody.status).toBe(400);

    const notFound = await postJson('/api/payment/999999999/refund', {}, { Authorization: `Bearer ${adminToken}` });
    expect(notFound.status).toBe(404);
  });

  it('refund: a real Razorpay rejection (unrecognized payment id) surfaces as 502, not a generic 500, and leaves the payment untouched', async () => {
    const orderRes = await postJson('/api/payment/orders/rfs-document', { tenderId, payerName: 'I', payerEmail: 'i@test.local', ...RFS_STAGE3_FIELDS });
    const payload = {
      entity: 'event',
      event: 'payment.captured',
      payload: { payment: { entity: { id: `pay_FAKE${Date.now()}`, order_id: orderRes.body.orderId } } },
    };
    const bodyString = JSON.stringify(payload);
    await postRaw('/api/payment/webhook', bodyString, { 'x-razorpay-signature': signWebhook(bodyString) });
    await new Promise((r) => setTimeout(r, 50));

    const payment = await Payment.findOne({ where: { razorpayOrderId: orderRes.body.orderId } });
    expect(payment!.status).toBe('paid');

    const refundRes = await postJson(`/api/payment/${payment!.id}/refund`, {}, { Authorization: `Bearer ${adminToken}` });
    expect(refundRes.status).toBe(502);

    const after = await Payment.findOne({ where: { razorpayOrderId: orderRes.body.orderId } });
    expect(after!.status).toBe('paid'); // unchanged — a rejected refund attempt must not corrupt state
    expect(after!.razorpayRefundId).toBeNull();
  });
});

// No Razorpay dependency — these exercise the invoice-retrieval route's ownership gate directly
// against Payment/Invoice rows, same as invoiceService.test.ts does for generation itself.
describe('GET /payment/:id/invoice', () => {
  it('returns 404 before any invoice has been generated for the payment', async () => {
    const payment = await Payment.create({
      purpose: 'bid_processing',
      tenderId,
      organizationId: buyerOrgId,
      razorpayOrderId: `order_INVOICE_ROUTE_TEST_${Date.now()}`,
      amountPaise: 100,
      currency: 'INR',
      status: 'created',
    });
    const res = await getJson(`/api/payment/${payment.id}/invoice`, { Authorization: `Bearer ${buyerToken}` });
    expect(res.status).toBe(404);
    await Payment.destroy({ where: { id: payment.id } });
  });

  it('requires the owning organization\'s token for an org-linked payment', async () => {
    const { generateInvoiceForPayment } = await import('../services/invoiceService.js');
    const payment = await Payment.create({
      purpose: 'bid_processing',
      tenderId,
      organizationId: buyerOrgId,
      razorpayOrderId: `order_INVOICE_ROUTE_TEST_${Date.now()}_2`,
      amountPaise: 100,
      currency: 'INR',
      status: 'paid',
    });
    await generateInvoiceForPayment(payment);

    const noAuth = await getJson(`/api/payment/${payment.id}/invoice`);
    expect(noAuth.status).toBe(403);

    const withAuth = await getJson(`/api/payment/${payment.id}/invoice`, { Authorization: `Bearer ${buyerToken}` });
    expect(withAuth.status).toBe(200);
    expect(typeof withAuth.body.url).toBe('string');

    const { Invoice } = await import('../models/Invoice.js');
    await Invoice.destroy({ where: { paymentId: payment.id } });
    await Payment.destroy({ where: { id: payment.id } });
  });

  it('gates an account-less rfs_document payment\'s invoice on the matching payerEmail instead', async () => {
    const { generateInvoiceForPayment } = await import('../services/invoiceService.js');
    const email = `invoice-owner-${Date.now()}@test.local`;
    const payment = await Payment.create({
      purpose: 'rfs_document',
      tenderId,
      organizationId: null,
      payerName: 'Invoice Owner',
      payerEmail: email,
      razorpayOrderId: `order_INVOICE_ROUTE_TEST_${Date.now()}_3`,
      amountPaise: 100,
      currency: 'INR',
      status: 'paid',
    });
    await generateInvoiceForPayment(payment);

    const wrongEmail = await getJson(`/api/payment/${payment.id}/invoice?email=someone-else@test.local`);
    expect(wrongEmail.status).toBe(403);

    const rightEmail = await getJson(`/api/payment/${payment.id}/invoice?email=${encodeURIComponent(email)}`);
    expect(rightEmail.status).toBe(200);

    const { Invoice } = await import('../models/Invoice.js');
    await Invoice.destroy({ where: { paymentId: payment.id } });
    await Payment.destroy({ where: { id: payment.id } });
  });
});
