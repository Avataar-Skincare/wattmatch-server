import { describe, it, expect, afterEach } from 'vitest';
import { Tender } from '../models/Tender.js';
import { Organization } from '../models/Organization.js';
import { Payment, type PaymentPurpose } from '../models/Payment.js';
import { Invoice } from '../models/Invoice.js';
import { generateInvoiceForPayment, generateMissingInvoices } from './invoiceService.js';
import { readObject } from '../lib/s3.js';

// AWS_S3_BUCKET is intentionally unset in this test env, so uploadObject/readObject exercise the
// local-storage fallback path (see lib/s3.ts) rather than needing real AWS credentials — the same
// approach already used for lib/secrets.ts's env-var fallback.

const createdTenderIds: number[] = [];
const createdOrgIds: number[] = [];
const createdPaymentIds: number[] = [];

afterEach(async () => {
  await Invoice.destroy({ where: { paymentId: createdPaymentIds } });
  await Payment.destroy({ where: { id: createdPaymentIds } });
  createdPaymentIds.length = 0;
  for (const id of createdOrgIds.splice(0)) await Organization.destroy({ where: { id } });
  for (const id of createdTenderIds.splice(0)) await Tender.destroy({ where: { id } });
});

interface PaymentOverrides {
  organizationId?: number | null;
  payerName?: string | null;
  payerEmail?: string | null;
  purpose?: PaymentPurpose;
}

async function makePaidPayment(overrides: PaymentOverrides = {}) {
  const buyer = await Organization.create({
    type: 'buyer',
    name: 'Invoice Test Buyer',
    contactEmail: `invoice-test-${Date.now()}-${Math.random()}@test.local`,
    contactPhone: '9000000000',
  });
  createdOrgIds.push(buyer.id);
  const tender = await Tender.create({ buyerOrgId: buyer.id, title: `Invoice test tender ${Date.now()}`, requiredCapacityMw: '5' });
  createdTenderIds.push(tender.id);

  const payment = await Payment.create({
    purpose: overrides.purpose ?? 'rfs_document',
    tenderId: tender.id,
    organizationId: overrides.organizationId ?? null,
    payerName: overrides.payerName === undefined ? 'Test Payer' : overrides.payerName,
    payerEmail: overrides.payerEmail === undefined ? `payer-${Date.now()}-${Math.random()}@test.local` : overrides.payerEmail,
    razorpayOrderId: `order_INV_TEST_${Date.now()}_${Math.random()}`,
    amountPaise: 10000,
    currency: 'INR',
    status: 'paid',
  });
  createdPaymentIds.push(payment.id);
  return payment;
}

describe('generateInvoiceForPayment', () => {
  it('generates a provisional receipt (no tax) when WATTMATCH_GSTIN is unset', async () => {
    delete process.env.WATTMATCH_GSTIN;
    const payment = await makePaidPayment();

    const invoice = await generateInvoiceForPayment(payment);
    expect(invoice).not.toBeNull();
    expect(invoice!.sellerGstin).toBeNull();
    expect(invoice!.amountPaise).toBe(payment.amountPaise); // no tax added
    expect(invoice!.invoiceNumber).toMatch(/^WM\/\d{4}-\d{2}\/\d{6}$/);

    const pdfBytes = await readObject(invoice!.s3Key);
    expect(pdfBytes).not.toBeNull();
    expect(pdfBytes!.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('generates a real tax invoice once WATTMATCH_GSTIN is configured', async () => {
    process.env.WATTMATCH_GSTIN = '27AAAAA0000A1Z5';
    process.env.WATTMATCH_GST_RATE_PERCENT = '18';
    try {
      const payment = await makePaidPayment();
      const invoice = await generateInvoiceForPayment(payment);
      expect(invoice!.sellerGstin).toBe('27AAAAA0000A1Z5');
      expect(invoice!.amountPaise).toBe(Math.round(payment.amountPaise * 1.18));
    } finally {
      delete process.env.WATTMATCH_GSTIN;
      delete process.env.WATTMATCH_GST_RATE_PERCENT;
    }
  });

  it('is idempotent — calling it twice for the same payment returns the same invoice, not a duplicate', async () => {
    const payment = await makePaidPayment();
    const first = await generateInvoiceForPayment(payment);
    const second = await generateInvoiceForPayment(payment);
    expect(second!.id).toBe(first!.id);

    const count = await Invoice.count({ where: { paymentId: payment.id } });
    expect(count).toBe(1);
  });

  it('resolves the buyer from the Organization when the payment has no payerName/payerEmail (org-linked purposes)', async () => {
    const buyer = await Organization.create({
      type: 'generator',
      name: 'Org-Linked Buyer',
      contactEmail: `org-linked-${Date.now()}@test.local`,
      contactPhone: '9000000001',
    });
    createdOrgIds.push(buyer.id);
    const payment = await makePaidPayment({ organizationId: buyer.id, payerName: null, payerEmail: null, purpose: 'bid_processing' });

    const invoice = await generateInvoiceForPayment(payment);
    expect(invoice!.buyerName).toBe('Org-Linked Buyer');
    expect(invoice!.buyerEmail).toBe(buyer.contactEmail);
  });
});

// Regression coverage for the self-healing fix: paymentStateMachine.ts's fire-and-forget call to
// generateInvoiceForPayment previously had no retry at all if it failed once — this is what catches
// that on the next check interval.
describe('generateMissingInvoices', () => {
  it('generates an invoice for a paid payment that never got one', async () => {
    const payment = await makePaidPayment();
    expect(await Invoice.findOne({ where: { paymentId: payment.id } })).toBeNull();

    await generateMissingInvoices();

    const invoice = await Invoice.findOne({ where: { paymentId: payment.id } });
    expect(invoice).not.toBeNull();
  });

  it('does not duplicate an invoice for a payment that already has one', async () => {
    const payment = await makePaidPayment();
    const first = await generateInvoiceForPayment(payment);

    await generateMissingInvoices();

    const count = await Invoice.count({ where: { paymentId: payment.id } });
    expect(count).toBe(1);
    const invoice = await Invoice.findOne({ where: { paymentId: payment.id } });
    expect(invoice!.id).toBe(first!.id);
  });
});
