import { describe, it, expect, afterEach } from 'vitest';
import { Organization } from '../models/Organization.js';
import { Tender } from '../models/Tender.js';
import { TenderInvitation } from '../models/TenderInvitation.js';
import { Payment } from '../models/Payment.js';
import { refundEmd, forfeitEmd } from './emdOutcomeService.js';

const createdOrgIds: number[] = [];
const createdTenderIds: number[] = [];

afterEach(async () => {
  for (const id of createdTenderIds.splice(0)) {
    await TenderInvitation.destroy({ where: { tenderId: id } });
    await Payment.destroy({ where: { tenderId: id } });
    await Tender.destroy({ where: { id } });
  }
  for (const id of createdOrgIds.splice(0)) await Organization.destroy({ where: { id } });
});

async function makeInvitation() {
  const buyer = await Organization.create({ type: 'buyer', name: 'EMD Test Buyer', contactEmail: `emd-buyer-${Date.now()}-${Math.random()}@test.local`, contactPhone: '9000000000' });
  createdOrgIds.push(buyer.id);
  const generator = await Organization.create({ type: 'generator', name: 'EMD Test Gen', contactEmail: `emd-gen-${Date.now()}-${Math.random()}@test.local`, contactPhone: '9000000001' });
  createdOrgIds.push(generator.id);
  const tender = await Tender.create({ buyerOrgId: buyer.id, title: `EMD test tender ${Date.now()}`, requiredCapacityMw: '1' });
  createdTenderIds.push(tender.id);
  const invitation = await TenderInvitation.create({ tenderId: tender.id, organizationId: generator.id, status: 'accepted', emdOutcome: 'pending' });
  return { tenderId: tender.id, organizationId: generator.id, invitation };
}

describe('refundEmd', () => {
  it('leaves the outcome pending and does not throw when no paid EMD payment exists at all', async () => {
    const { tenderId, organizationId } = await makeInvitation();

    await refundEmd(tenderId, organizationId, 'test: nothing to refund');

    const invitation = await TenderInvitation.findOne({ where: { tenderId, organizationId } });
    expect(invitation!.emdOutcome).toBe('pending');
  });

  it('leaves the outcome pending when the EMD payment has no recorded razorpayPaymentId', async () => {
    const { tenderId, organizationId } = await makeInvitation();
    await Payment.create({
      purpose: 'emd', tenderId, organizationId,
      razorpayOrderId: `order_UNIT_TEST_${Date.now()}`,
      amountPaise: 100, currency: 'INR', status: 'paid',
    });

    await refundEmd(tenderId, organizationId, 'test: missing payment id');

    const invitation = await TenderInvitation.findOne({ where: { tenderId, organizationId } });
    expect(invitation!.emdOutcome).toBe('pending');
  });

  it('leaves the outcome pending when Razorpay rejects the refund (synthetic payment id)', async () => {
    const { tenderId, organizationId } = await makeInvitation();
    await Payment.create({
      purpose: 'emd', tenderId, organizationId,
      razorpayOrderId: `order_UNIT_TEST_${Date.now()}`,
      razorpayPaymentId: `pay_FAKE_${Date.now()}`,
      amountPaise: 100, currency: 'INR', status: 'paid',
    });

    await refundEmd(tenderId, organizationId, 'test: razorpay rejects');

    const invitation = await TenderInvitation.findOne({ where: { tenderId, organizationId } });
    expect(invitation!.emdOutcome).toBe('pending');
  });

  it('is a no-op once the outcome is already settled — never re-attempts a refund', async () => {
    const { tenderId, organizationId, invitation } = await makeInvitation();
    await invitation.update({ emdOutcome: 'forfeited', emdOutcomeAt: new Date(), emdOutcomeReason: 'already settled' });

    // No EMD Payment created at all — if this didn't short-circuit on the emdOutcome check first,
    // it would still just no-op (no payment found), so the real thing this proves is that a
    // *refunded* outcome from a previous call is never silently overwritten by a later one.
    await refundEmd(tenderId, organizationId, 'should not apply');

    const reloaded = await TenderInvitation.findOne({ where: { tenderId, organizationId } });
    expect(reloaded!.emdOutcome).toBe('forfeited');
    expect(reloaded!.emdOutcomeReason).toBe('already settled');
  });
});

describe('forfeitEmd', () => {
  it('marks the outcome forfeited without needing any Payment record', async () => {
    const { tenderId, organizationId } = await makeInvitation();

    await forfeitEmd(tenderId, organizationId, 'test: forfeit');

    const invitation = await TenderInvitation.findOne({ where: { tenderId, organizationId } });
    expect(invitation!.emdOutcome).toBe('forfeited');
  });

  it('is a no-op once the outcome is already settled', async () => {
    const { tenderId, organizationId, invitation } = await makeInvitation();
    await invitation.update({ emdOutcome: 'refunded', emdOutcomeAt: new Date(), emdOutcomeReason: 'already refunded' });

    await forfeitEmd(tenderId, organizationId, 'should not apply');

    const reloaded = await TenderInvitation.findOne({ where: { tenderId, organizationId } });
    expect(reloaded!.emdOutcome).toBe('refunded');
  });
});
