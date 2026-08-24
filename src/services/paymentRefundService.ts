import { Payment } from '../models/Payment.js';
import { refund as razorpayRefund } from '../lib/razorpayAdapter.js';
import { transitionPayment } from './paymentStateMachine.js';
import { logger } from '../lib/logger.js';

export type RefundOutcome =
  | { ok: true; refundId: string; status: string }
  | { ok: false; reason: 'not_paid' | 'missing_payment_id' | 'razorpay_rejected'; message: string };

// Single source of truth for actually refunding a payment via Razorpay — used by the admin-
// triggered POST /payment/:id/refund route AND emdOutcomeService.ts's refundEmd, so there is
// exactly one place that calls Razorpay's refund API and transitions payment state, not two copies
// that could silently drift apart. Extracted from routes/payments.ts, behavior unchanged.
export async function refundPayment(payment: Payment, amountPaise?: number): Promise<RefundOutcome> {
  if (payment.status !== 'paid') {
    return { ok: false, reason: 'not_paid', message: `Cannot refund a payment in status '${payment.status}' — only a paid payment can be refunded` };
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

  // Instant refunds (most methods) come back already 'processed' — transition right away rather
  // than waiting on a webhook that, for these, may never meaningfully add information. Pending
  // refunds (some bank-transfer methods) stay 'paid' until the refund.processed webhook confirms
  // completion — transitionPayment's own idempotency means whichever path fires first wins and the
  // other is a safe no-op.
  if (result.status === 'processed') {
    await transitionPayment(payment, 'refunded');
  }

  logger.info(
    { paymentId: payment.id, refundId: result.refundId, razorpayStatus: result.status, amountPaise: amountPaise ?? payment.amountPaise },
    '[PAYMENT] refund initiated'
  );

  return { ok: true, refundId: result.refundId, status: result.status };
}
