import { Payment } from '../models/Payment.js';
import { refund as razorpayRefund } from '../lib/razorpayAdapter.js';
import { applyRefundAmount } from './paymentStateMachine.js';
import { logger } from '../lib/logger.js';

export type RefundOutcome =
  | { ok: true; refundId: string; status: string }
  | { ok: false; reason: 'not_paid' | 'missing_payment_id' | 'razorpay_rejected'; message: string };

// Single source of truth for actually refunding a payment via Razorpay — used by the admin-
// triggered POST /payment/:id/refund route. EMD used to be refunded through here too, but EMD is
// now a document, not money (see EmdSubmission.ts) — this is the only real-money refund path left.
// Extracted from routes/payments.ts, behavior unchanged.
export async function refundPayment(payment: Payment, amountPaise?: number): Promise<RefundOutcome> {
  // 'partially_refunded' is refundable too — a payment only becomes fully 'refunded' (terminal)
  // once its cumulative refunded amount actually covers amountPaise (see applyRefundAmount).
  if (payment.status !== 'paid' && payment.status !== 'partially_refunded') {
    return { ok: false, reason: 'not_paid', message: `Cannot refund a payment in status '${payment.status}' — only a paid or partially refunded payment can be refunded` };
  }
  if (!payment.razorpayPaymentId) {
    // Should be unreachable (status is only ever 'paid' alongside a recorded payment id), but a
    // refund call needs a real Razorpay payment id to act on — fail loudly rather than send a
    // malformed request to Razorpay if this invariant is ever somehow violated.
    return { ok: false, reason: 'missing_payment_id', message: 'Payment has no recorded razorpayPaymentId — cannot refund' };
  }

  let result;
  try {
    result = await razorpayRefund({ paymentId: payment.razorpayPaymentId, amountPaise });
  } catch (err) {
    // A rejection from Razorpay itself (bad payment id, already fully refunded, insufficient
    // account balance) is an expected, legitimate outcome — not a bug in this server.
    const description = (err as { error?: { description?: string } })?.error?.description;
    logger.error({ paymentId: payment.id, razorpayPaymentId: payment.razorpayPaymentId, err }, '[PAYMENT] refund rejected by Razorpay');
    return { ok: false, reason: 'razorpay_rejected', message: description || 'Razorpay rejected this refund request' };
  }

  await payment.update({ razorpayRefundId: result.refundId });

  // Instant refunds (most methods) come back already 'processed' — apply the amount right away
  // rather than waiting on a webhook that, for these, may never meaningfully add information.
  // Pending refunds (some bank-transfer methods) are left unapplied until the refund.processed
  // webhook confirms completion — applyRefundAmount's own de-dup guard means whichever path
  // eventually fires for this refund id is the one that counts, and a second delivery is a safe
  // no-op either way.
  if (result.status === 'processed') {
    await applyRefundAmount(payment, result.refundId, result.amountPaise);
  }

  logger.info(
    { paymentId: payment.id, refundId: result.refundId, razorpayStatus: result.status, amountPaise: amountPaise ?? payment.amountPaise },
    '[PAYMENT] refund initiated'
  );

  return { ok: true, refundId: result.refundId, status: result.status };
}
