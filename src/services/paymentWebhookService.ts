import { Payment } from '../models/Payment.js';
import { transitionPayment } from './paymentStateMachine.js';
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
  const result = await transitionPayment(record, 'refunded');
  if (result.applied) logger.info({ paymentId: record.id, refundId: refundEntity.id }, '[WEBHOOK] refund.processed — marked refunded');
}
