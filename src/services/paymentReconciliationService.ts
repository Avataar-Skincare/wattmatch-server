import { Op } from 'sequelize';
import { Payment } from '../models/Payment.js';
import { fetchOrderPayments } from '../lib/razorpayAdapter.js';
import { transitionPayment } from './paymentStateMachine.js';
import { logger } from '../lib/logger.js';

// Section 7's "the user paid but no callback and no webhook arrived" recovery path. Both /verify
// and the webhook are best-effort delivery mechanisms — this is the backstop that asks Razorpay
// directly, for anything that's been sitting in 'created' long enough that it's no longer plausibly
// "still on the checkout page," rather than trusting either of those to have eventually arrived.
export const STALE_THRESHOLD_MS = 30 * 60 * 1000;

export interface ReconciliationResult {
  checked: number;
  updated: Array<{ paymentId: number; from: string; to: string }>;
}

export async function reconcileStalePayments(): Promise<ReconciliationResult> {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
  const stale = await Payment.findAll({ where: { status: 'created', createdAt: { [Op.lt]: cutoff } } });

  const updated: ReconciliationResult['updated'] = [];
  for (const payment of stale) {
    try {
      const attempts = await fetchOrderPayments(payment.razorpayOrderId);
      // An order can have more than one attempt (e.g. a failed card retry followed by a successful
      // UPI payment) — a captured attempt anywhere in the list means the order is actually paid,
      // regardless of how many earlier attempts failed first.
      const captured = attempts.find((a) => a.status === 'captured');
      const allFailed = attempts.length > 0 && attempts.every((a) => a.status === 'failed');

      if (captured) {
        const result = await transitionPayment(payment, 'paid', { razorpayPaymentId: captured.paymentId });
        if (result.applied) updated.push({ paymentId: payment.id, from: 'created', to: 'paid' });
      } else if (allFailed) {
        const result = await transitionPayment(payment, 'failed', { razorpayPaymentId: attempts[0].paymentId });
        if (result.applied) updated.push({ paymentId: payment.id, from: 'created', to: 'failed' });
      }
      // No attempts at all: genuinely abandoned at checkout — left as 'created', nothing to
      // reconcile against yet. Not an error, just nothing happened on Razorpay's side either.
    } catch (err) {
      logger.error({ paymentId: payment.id, razorpayOrderId: payment.razorpayOrderId, err }, '[RECONCILE] failed to fetch order status from Razorpay');
    }
  }

  logger.info({ checked: stale.length, updatedCount: updated.length }, '[RECONCILE] run complete');
  return { checked: stale.length, updated };
}
