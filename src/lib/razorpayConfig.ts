import { loadSecret } from './secrets.js';
import { logger } from './logger.js';

// Same loadSecret() pattern used for ORG_JWT_SECRET/FIELD_ENCRYPTION_KEY — env var locally, AWS
// Secrets Manager in production, fetched once and cached. RAZORPAY_KEY_ID is NOT run through this:
// it's a public identifier (sent to the frontend for checkout), not a secret, so it's a plain env
// var like CORS_ORIGIN. Only RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET are actually sensitive.

export interface RazorpayConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  currency: string;
  isLiveMode: boolean;
}

let cached: RazorpayConfig | null = null;

export async function getRazorpayConfig(): Promise<RazorpayConfig> {
  if (cached) return cached;

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = await loadSecret('RAZORPAY_KEY_SECRET', 'RAZORPAY_KEY_SECRET_ARN');
  const webhookSecret = await loadSecret('RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_WEBHOOK_SECRET_ARN');
  const currency = process.env.CURRENCY ?? 'INR';

  if (!keyId || !keySecret || !webhookSecret) {
    logger.error(
      { hasKeyId: Boolean(keyId), hasKeySecret: Boolean(keySecret), hasWebhookSecret: Boolean(webhookSecret) },
      '[RAZORPAY] configuration incomplete — RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET must all be set'
    );
    throw new Error('Razorpay is not configured — see RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET/RAZORPAY_WEBHOOK_SECRET');
  }

  // Derived, never a separate env var to keep in sync — a test-mode key id can never accidentally
  // report itself as live.
  const isLiveMode = keyId.startsWith('rzp_live_');

  cached = { keyId, keySecret, webhookSecret, currency, isLiveMode };
  return cached;
}
