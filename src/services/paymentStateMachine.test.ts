import { describe, it, expect, afterEach } from 'vitest';
import { Tender } from '../models/Tender.js';
import { Organization } from '../models/Organization.js';
import { Payment } from '../models/Payment.js';
import { applyRefundAmount } from './paymentStateMachine.js';

// applyRefundAmount used to do a plain read-modify-write of amountRefundedPaise/notes — two refunds
// confirmed concurrently for the same payment (two distinct partial refunds, or a refund's own
// synchronous confirmation racing its later webhook) could both read the same starting amount and
// have the second write silently clobber the first's contribution. These tests fire genuinely
// concurrent calls and assert the ledger ends up with BOTH contributions, not just whichever wrote
// last — the exact race the atomic `WHERE amountRefundedPaise = :from` guard now prevents.

const createdTenderIds: number[] = [];
const createdOrgIds: number[] = [];
const createdPaymentIds: number[] = [];

afterEach(async () => {
  if (createdPaymentIds.length) await Payment.destroy({ where: { id: createdPaymentIds } });
  if (createdTenderIds.length) await Tender.destroy({ where: { id: createdTenderIds } });
  if (createdOrgIds.length) await Organization.destroy({ where: { id: createdOrgIds } });
  createdPaymentIds.length = 0;
  createdTenderIds.length = 0;
  createdOrgIds.length = 0;
});

async function makePaidPayment(amountPaise: number): Promise<Payment> {
  const buyer = await Organization.create({ type: 'buyer', name: 'Refund Race Buyer', contactEmail: `refund-race-${Date.now()}@test.local`, contactPhone: '9000000002' });
  createdOrgIds.push(buyer.id);
  const tender = await Tender.create({ buyerOrgId: buyer.id, title: `Refund race tender ${Date.now()}`, requiredCapacityMw: '5' });
  createdTenderIds.push(tender.id);
  const payment = await Payment.create({
    purpose: 'bid_processing',
    tenderId: tender.id,
    organizationId: buyer.id,
    razorpayOrderId: `order_REFUND_RACE_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    razorpayPaymentId: `pay_REFUND_RACE_${Date.now()}`,
    amountPaise,
    currency: 'INR',
    status: 'paid',
  });
  createdPaymentIds.push(payment.id);
  return payment;
}

describe('applyRefundAmount concurrency', () => {
  it('two distinct partial refunds confirmed concurrently both land in the ledger, not just the last writer', async () => {
    const payment = await makePaidPayment(10_000);

    // Two independent Payment instances, mirroring how the real callers load the row separately
    // (refundPayment's route-level findByPk vs. the webhook handler's own findOne) — using the same
    // JS object for both calls wouldn't exercise the actual race, since Sequelize instance state
    // would be shared in-process.
    const instanceA = (await Payment.findByPk(payment.id))!;
    const instanceB = (await Payment.findByPk(payment.id))!;

    // Not asserting resultA.applied === resultB.applied === true here: each call's `applied` flag
    // reflects the NESTED transitionPayment status-change race too (both are transitioning
    // paid -> partially_refunded), and only one of two concurrent callers can legitimately win that
    // — same as transitionPayment's own documented behavior elsewhere. What must NOT race is the
    // money itself, which is applied unconditionally (via the atomic amountRefundedPaise guard)
    // before transitionPayment is ever called — that's what the final ledger assertions below check.
    await Promise.all([
      applyRefundAmount(instanceA, 'rfnd_A', 3_000),
      applyRefundAmount(instanceB, 'rfnd_B', 4_000),
    ]);

    const final = (await Payment.findByPk(payment.id))!;
    expect(final.amountRefundedPaise).toBe(7_000);
    expect(final.status).toBe('partially_refunded');
    const appliedRefundIds = (final.notes as { appliedRefundIds?: string[] })?.appliedRefundIds ?? [];
    expect(appliedRefundIds.sort()).toEqual(['rfnd_A', 'rfnd_B']);
  });

  it('the same refund confirmed twice concurrently (synchronous response racing its own webhook) is only applied once', async () => {
    const payment = await makePaidPayment(5_000);
    const instanceA = (await Payment.findByPk(payment.id))!;
    const instanceB = (await Payment.findByPk(payment.id))!;

    const [resultA, resultB] = await Promise.all([
      applyRefundAmount(instanceA, 'rfnd_SAME', 5_000),
      applyRefundAmount(instanceB, 'rfnd_SAME', 5_000),
    ]);

    // Exactly one of the two actually applied the amount; the other detected it was already applied.
    expect([resultA.applied, resultB.applied].filter(Boolean)).toHaveLength(1);

    const final = (await Payment.findByPk(payment.id))!;
    expect(final.amountRefundedPaise).toBe(5_000);
    expect(final.status).toBe('refunded');
    const appliedRefundIds = (final.notes as { appliedRefundIds?: string[] })?.appliedRefundIds ?? [];
    expect(appliedRefundIds).toEqual(['rfnd_SAME']);
  });
});
