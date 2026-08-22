import Razorpay from 'razorpay';
import crypto from 'node:crypto';
import { getRazorpayConfig } from './razorpayConfig.js';

// Thin adapter — every route/service talks to THIS interface, never to the Razorpay SDK directly.
// The point: if the payment gateway ever changes, only this file changes. Four operations, matching
// exactly what the rest of the payment module needs: create an order, verify the browser's success
// callback, verify a webhook delivery, and issue a refund.

export interface CreateOrderInput {
  amountPaise: number;
  currency: string;
  receipt: string;
  notes?: Record<string, string>;
}

export interface CreateOrderResult {
  orderId: string;
  amountPaise: number;
  currency: string;
}

export interface VerifyCallbackInput {
  orderId: string;
  paymentId: string;
  signature: string;
}

export interface RefundInput {
  paymentId: string;
  amountPaise?: number; // omit for a full refund
}

export interface RefundResult {
  refundId: string;
  status: string;
}

let client: Razorpay | null = null;
async function getClient(): Promise<Razorpay> {
  if (client) return client;
  const { keyId, keySecret } = await getRazorpayConfig();
  client = new Razorpay({ key_id: keyId, key_secret: keySecret });
  return client;
}

export async function createOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
  const rzp = await getClient();
  const order = await rzp.orders.create({
    amount: input.amountPaise,
    currency: input.currency,
    receipt: input.receipt,
    notes: input.notes,
  });
  return { orderId: order.id, amountPaise: Number(order.amount), currency: order.currency };
}

// HMAC-SHA256 over `${orderId}|${paymentId}` with key_secret — this is Razorpay's client-callback
// verification scheme, a DIFFERENT signature and secret from the webhook one below. Uses
// crypto.timingSafeEqual rather than string equality — a plain `===` on the resulting hex strings
// is technically vulnerable to a timing side-channel that leaks how many leading bytes matched.
export async function verifyCallback(input: VerifyCallbackInput): Promise<boolean> {
  const { keySecret } = await getRazorpayConfig();
  const expected = crypto.createHmac('sha256', keySecret).update(`${input.orderId}|${input.paymentId}`).digest('hex');
  return timingSafeEqualHex(expected, input.signature);
}

// Webhook signature verification — HMAC-SHA256 of the RAW request body (not the re-serialized
// parsed object — see index.ts's express.json({verify}) capturing req.rawBody for exactly this
// reason) using the separate webhook secret, never the key_secret used above.
export async function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): Promise<boolean> {
  if (!signatureHeader) return false;
  const { webhookSecret } = await getRazorpayConfig();
  const expected = crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');
  return timingSafeEqualHex(expected, signatureHeader);
}

function timingSafeEqualHex(expectedHex: string, actualHex: string): boolean {
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = Buffer.from(actualHex, 'hex');
  // Different lengths would throw inside timingSafeEqual — an intentionally malformed/short header
  // must fail cleanly, not crash the request.
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

export interface OrderPaymentAttempt {
  paymentId: string;
  status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed';
}

// A fifth adapter method, beyond the four the original brief specified — needed for Section 7's
// reconciliation job (checking Razorpay's own record for an order stuck in 'created' locally, in
// case our webhook delivery was lost and the browser callback never fired either). The four-method
// interface covered the core checkout flow; reconciliation is a distinct, later-discovered need,
// not something to force awkwardly into one of the other four.
export async function fetchOrderPayments(orderId: string): Promise<OrderPaymentAttempt[]> {
  const rzp = await getClient();
  const result = await rzp.orders.fetchPayments(orderId);
  return result.items.map((item) => ({ paymentId: item.id, status: item.status }));
}

export async function refund(input: RefundInput): Promise<RefundResult> {
  const rzp = await getClient();
  const result = await rzp.payments.refund(input.paymentId, input.amountPaise ? { amount: input.amountPaise } : {});
  return { refundId: result.id, status: result.status ?? 'processed' };
}
