// Local webhook test harness — no tunnel needed. Builds a realistic Razorpay webhook payload for
// one of the supported event types, signs the EXACT string that gets sent as the request body
// (never a separately re-serialized copy — that would break the HMAC and send you debugging the
// wrong thing), and POSTs it straight to the running server's webhook route.
//
// Usage:
//   node scripts/fakeWebhook.mjs payment.captured order_XXXX [payment_id]
//   node scripts/fakeWebhook.mjs payment.failed order_XXXX [payment_id]
//   node scripts/fakeWebhook.mjs refund.processed payment_id [refund_id]
//   node scripts/fakeWebhook.mjs payment.captured order_XXXX --invalid-signature
//
// Named .mjs, not .js, matching every other script in this directory (generate-vetting-keypairs.mjs
// etc.) — functionally identical either way since this whole package is "type": "module".

import 'dotenv/config';
import crypto from 'node:crypto';

const WEBHOOK_URL = process.env.FAKE_WEBHOOK_URL || `http://localhost:${process.env.PORT || 4000}/api/payment/webhook`;
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;

const [, , eventType, primaryId, secondaryIdRaw] = process.argv;
const invalidSignature = process.argv.includes('--invalid-signature');
const secondaryId = secondaryIdRaw && !secondaryIdRaw.startsWith('--') ? secondaryIdRaw : undefined;

if (!eventType || !primaryId) {
  console.error('Usage: node scripts/fakeWebhook.mjs <payment.captured|payment.failed|refund.processed> <order_id|payment_id> [second_id] [--invalid-signature]');
  process.exit(1);
}
if (!WEBHOOK_SECRET) {
  console.error('RAZORPAY_WEBHOOK_SECRET is not set in .env — cannot sign a payload.');
  process.exit(1);
}

function buildPayload() {
  const now = Math.floor(Date.now() / 1000);
  const fakePaymentId = secondaryId || `pay_FAKE${Date.now()}`;

  if (eventType === 'payment.captured' || eventType === 'payment.failed') {
    const status = eventType === 'payment.captured' ? 'captured' : 'failed';
    return {
      entity: 'event',
      account_id: 'acc_fake_local_test',
      event: eventType,
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: fakePaymentId,
            entity: 'payment',
            amount: 100,
            currency: 'INR',
            status,
            order_id: primaryId,
            method: 'card',
            captured: status === 'captured',
          },
        },
      },
      created_at: now,
    };
  }

  if (eventType === 'refund.processed') {
    const refundId = secondaryId || `rfnd_FAKE${Date.now()}`;
    return {
      entity: 'event',
      account_id: 'acc_fake_local_test',
      event: 'refund.processed',
      contains: ['refund'],
      payload: {
        refund: {
          entity: {
            id: refundId,
            entity: 'refund',
            amount: 100,
            currency: 'INR',
            payment_id: primaryId, // here primaryId is the payment id being refunded
            status: 'processed',
          },
        },
      },
      created_at: now,
    };
  }

  console.error(`Unsupported event type: ${eventType}`);
  process.exit(1);
}

const payload = buildPayload();
// Sign THIS exact string — the one that gets sent as the body below. Building the string once and
// reusing it (rather than JSON.stringify-ing the object twice) is what guarantees the signature
// matches what the server receives byte-for-byte.
const bodyString = JSON.stringify(payload);
const validSignature = crypto.createHmac('sha256', WEBHOOK_SECRET).update(bodyString).digest('hex');
const signature = invalidSignature ? `${validSignature.slice(0, -4)}dead` : validSignature;

const res = await fetch(WEBHOOK_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': signature },
  body: bodyString,
});
const responseBody = await res.text();

console.log(`POST ${WEBHOOK_URL}`);
console.log(`Event: ${eventType}${invalidSignature ? ' (with a deliberately corrupted signature)' : ''}`);
console.log(`Status: ${res.status}`);
console.log(`Body: ${responseBody}`);
