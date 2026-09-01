import { Payment } from '../models/Payment.js';
import { transitionPayment, applyRefundAmount } from './paymentStateMachine.js';
import { logger } from '../lib/logger.js';

// Event handlers, separated from the route so they're directly unit-testable and so the route
// itself stays a thin parse -> verify -> dispatch -> respond shape. Idempotency is achieved through
// Payment.status itself, enforced by paymentStateMachine.ts's legal-transition table — not a
// separate "seen event ids" table: Razorpay's webhook payload doesn't carry a stable top-level
// event id in every account configuration, but every event here already carries the order/payment
// id needed to look up the one Payment row it concerns, and that row's current status (via the
// shared state machine) is sufficient to detect "already handled."

interface RazorpayPaymentEntity {
  id: string;
  order_id: string;
}

interface RazorpayRefundEntity {
  id: string;
  payment_id: string;
  // Paise refunded by THIS specific refund — not necessarily the payment's full amountPaise. Needed
  // to tell a partial refund from a full one (see paymentStateMachine.ts's applyRefundAmount).
  amount: number;
}

export async function processPaymentCaptured(payment: RazorpayPaymentEntity): Promise<void> {
  const record = await Payment.findOne({ where: { razorpayOrderId: payment.order_id } });
  if (!record) {
    logger.warn({ orderId: payment.order_id, paymentId: payment.id }, '[WEBHOOK] payment.captured for unknown order — ignoring');
    return;
  }
  const result = await transitionPayment(record, 'paid', { razorpayPaymentId: payment.id });
  if (result.applied) logger.info({ paymentId: record.id, razorpayPaymentId: payment.id }, '[WEBHOOK] payment.captured — marked paid');
}

export async function processPaymentFailed(payment: RazorpayPaymentEntity): Promise<void> {
  const record = await Payment.findOne({ where: { razorpayOrderId: payment.order_id } });
  if (!record) {
    logger.warn({ orderId: payment.order_id, paymentId: payment.id }, '[WEBHOOK] payment.failed for unknown order — ignoring');
    return;
  }
  const result = await transitionPayment(record, 'failed', { razorpayPaymentId: payment.id });
  if (result.applied) logger.info({ paymentId: record.id, razorpayPaymentId: payment.id }, '[WEBHOOK] payment.failed — marked failed');
}

// Minimal handler — the full refund-initiation flow is Section 8's job. This exists so a refund
// that Razorpay confirms asynchronously is reflected here regardless of whether it was initiated
// through this platform's own (not yet built) refund endpoint or directly in the Razorpay
// dashboard.
export async function processRefundProcessed(refundEntity: RazorpayRefundEntity): Promise<void> {
  const record = await Payment.findOne({ where: { razorpayPaymentId: refundEntity.payment_id } });
  if (!record) {
    logger.warn({ paymentId: refundEntity.payment_id, refundId: refundEntity.id }, '[WEBHOOK] refund.processed for unknown payment — ignoring');
    return;
  }
  const result = await applyRefundAmount(record, refundEntity.id, refundEntity.amount);
  if (result.applied) logger.info({ paymentId: record.id, refundId: refundEntity.id, status: record.status }, '[WEBHOOK] refund.processed — amount applied');
}

// Without this, a refund that fails after being initiated (some bank-transfer methods confirm
// asynchronously) left the payment's razorpayRefundId pointing at a refund that will never
// complete, with nothing in the log above a generic level and no way to tell "refund pending" from
// "refund silently died" apart from checking with Razorpay directly. Payment.status is
// deliberately left untouched — refundPayment never optimistically transitioned it for a pending
// refund (see that file's own comment), so there's nothing to roll back; this only clears the
// stale pointer so a fresh retry isn't confused with the one that just failed.
export async function processRefundFailed(refundEntity: RazorpayRefundEntity): Promise<void> {
  const record = await Payment.findOne({ where: { razorpayRefundId: refundEntity.id } });
  if (!record) {
    logger.warn({ refundId: refundEntity.id }, '[WEBHOOK] refund.failed for unknown refund — ignoring');
    return;
  }
  logger.error(
    { paymentId: record.id, refundId: refundEntity.id },
    '[WEBHOOK] refund.failed — refund did not complete, payment status unchanged; admin should retry via POST /payment/:id/refund'
  );
  await record.update({ razorpayRefundId: null });
}
