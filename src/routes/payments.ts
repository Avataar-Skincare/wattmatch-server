import { Router } from 'express';
import { jsonRateLimit as rateLimit } from '../lib/rateLimit.js';
import { z } from 'zod';
import { Op } from 'sequelize';
import { Payment, type PaymentPurpose } from '../models/Payment.js';
import { Tender } from '../models/Tender.js';
import { computeAmountPaise } from '../services/pricingService.js';
import { createOrder, verifyCallback, verifyWebhookSignature } from '../lib/razorpayAdapter.js';
import { processPaymentCaptured, processPaymentFailed, processRefundProcessed, processRefundFailed } from '../services/paymentWebhookService.js';
import { transitionPayment } from '../services/paymentStateMachine.js';
import { reconcileStalePayments } from '../services/paymentReconciliationService.js';
import { refundPayment } from '../services/paymentRefundService.js';
import { getRazorpayConfig } from '../lib/razorpayConfig.js';
import { Invoice } from '../models/Invoice.js';
import { getSignedDownloadUrl } from '../lib/s3.js';
import { authRequired, optionalAuth } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';
import { withLock, LockContentionError } from '../lib/distributedLock.js';

const router = Router();

const MAX_STRING_FIELD_LENGTH = 255;
const orderLimiter = rateLimit({ name: 'payments:order', windowMs: 15 * 60 * 1000, limit: 30 });

// Both schemas explicitly do NOT declare an `amount`/`amountPaise` field — Zod's default (strict
// object shape via .strict() below) means a body that includes one is rejected outright, rather
// than silently ignored, catching a confused or malicious client immediately instead of quietly
// discarding what looks like an attempt to control the price.
const rfsDocumentOrderBodySchema = z
  .object({
    tenderId: z.number().int().positive(),
    payerName: z.string().trim().min(1, 'payerName is required').max(MAX_STRING_FIELD_LENGTH),
    payerEmail: z.string().trim().toLowerCase().email().max(MAX_STRING_FIELD_LENGTH),
    // Stage 3's full form, as real structured fields (TENDER_WORKFLOW_STAKEHOLDER_PLAN.md) — not
    // folded into a generic notes bag, since this is core intake data the plan names explicitly.
    company: z.string().trim().min(1, 'company is required').max(MAX_STRING_FIELD_LENGTH),
    designation: z.string().trim().min(1, 'designation is required').max(MAX_STRING_FIELD_LENGTH),
    mobile: z.string().trim().min(1, 'mobile is required').max(30),
    isGenerator: z.boolean(),
    // DPDP Act (Red Flag #1) — z.literal(true) rejects a missing/false value outright rather than
    // silently defaulting, so a client simply can't submit without the box actually being checked.
    consentGiven: z.literal(true, { message: 'Consent is required to proceed' }),
    notes: z.record(z.string(), z.string().max(1000)).optional(),
  })
  .strict();

const orgOrderBodySchema = z
  .object({
    purpose: z.enum(['bid_processing']),
    tenderId: z.number().int().positive(),
  })
  .strict();

const verifyBodySchema = z
  .object({
    razorpayOrderId: z.string().trim().min(1).max(MAX_STRING_FIELD_LENGTH),
    razorpayPaymentId: z.string().trim().min(1).max(MAX_STRING_FIELD_LENGTH),
    razorpaySignature: z.string().trim().min(1).max(MAX_STRING_FIELD_LENGTH),
  })
  .strict();

const verifyLimiter = rateLimit({ name: 'payments:verify', windowMs: 15 * 60 * 1000, limit: 30 });

// Covers the dedup check + Razorpay order creation + local DB write below as one critical section
// — see createPaymentOrder's own comment for why order creation and the DB write can't be one DB
// transaction (there's nothing to write until Razorpay has returned an order id). Without this lock,
// two concurrent requests for the same tender+purpose+payer (a double-click, a retried fetch, two
// open tabs) can both pass the "no existing order" check before either row exists, producing two
// separate Razorpay orders for the same fee — and a real double charge if both get paid. TTL is
// generously above razorpayAdapter's own 15s request timeout so a slow-but-successful Razorpay call
// is never pre-empted by its own lock expiring.
const PAYMENT_ORDER_LOCK_TTL_MS = 20_000;

async function createPaymentOrder(input: {
  purpose: PaymentPurpose;
  tenderId: number;
  organizationId: number | null;
  payerName: string | null;
  payerEmail: string | null;
  payerCompany?: string | null;
  payerDesignation?: string | null;
  payerMobile?: string | null;
  payerIsGenerator?: boolean | null;
  consentGivenAt?: Date | null;
  notes: Record<string, unknown> | null;
}) {
  const { keyId, currency } = await getRazorpayConfig();
  const amountPaise = await computeAmountPaise({
    purpose: input.purpose,
    tenderId: input.tenderId,
    organizationId: input.organizationId ?? undefined,
  });

  // Razorpay order first, THEN persist — razorpayOrderId is required+unique on Payment, so there is
  // no valid row to write until Razorpay has actually returned one. This does mean a crash between
  // the two steps leaves an order on Razorpay's side with no local record; Section 7's
  // reconciliation job is exactly what recovers that case, not something this function guards
  // against itself.
  const order = await createOrder({
    amountPaise,
    currency,
    receipt: `pending-${input.purpose}-${input.tenderId}-${Date.now()}`,
  });

  const payment = await Payment.create({
    purpose: input.purpose,
    tenderId: input.tenderId,
    organizationId: input.organizationId,
    payerName: input.payerName,
    payerEmail: input.payerEmail,
    payerCompany: input.payerCompany ?? null,
    payerDesignation: input.payerDesignation ?? null,
    payerMobile: input.payerMobile ?? null,
    payerIsGenerator: input.payerIsGenerator ?? null,
    consentGivenAt: input.consentGivenAt ?? null,
    razorpayOrderId: order.orderId,
    amountPaise: order.amountPaise,
    currency: order.currency,
    status: 'created',
    notes: input.notes,
  });

  logger.info(
    { paymentId: payment.id, purpose: input.purpose, tenderId: input.tenderId, orderId: order.orderId, amountPaise: order.amountPaise },
    '[PAYMENT] order created'
  );

  return { orderId: order.orderId, amount: order.amountPaise, currency: order.currency, keyId };
}

// Public — no account required, matching Stage 3's deliberately account-less RfS Document
// purchase. This is the ONE payment purpose that is ever created without auth; every other purpose
// goes through the authenticated route below.
router.post('/payment/orders/rfs-document', orderLimiter, async (req, res, next) => {
  try {
    const parsed = rfsDocumentOrderBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }
    const { tenderId, payerEmail } = parsed.data;

    const tender = await Tender.findByPk(tenderId);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });

    const lockKey = `payment-order-lock:rfs_document:${tenderId}:${payerEmail}`;
    try {
      const result = await withLock(lockKey, PAYMENT_ORDER_LOCK_TTL_MS, async () => {
        // De-dup guard: without this, the same person (or a retried/double-clicked frontend
        // request) could be charged twice for the same tender's document. Not in a terminal
        // 'failed' state means 'created'/'attempted'/'paid' — a failed attempt doesn't block a
        // genuine retry. Run inside the lock above so a second concurrent request can't read
        // "nothing exists yet" before the first one's Payment.create has landed.
        const existing = await Payment.findOne({
          where: { tenderId, payerEmail, purpose: 'rfs_document', status: { [Op.ne]: 'failed' } },
          order: [['id', 'DESC']],
        });
        if (existing) {
          if (existing.status === 'paid') {
            return { alreadyPaid: true as const };
          }
          // Still in progress ('created'/'attempted') — resume that same order rather than
          // spawning a second one; the frontend's checkout flow behaves identically either way.
          const { keyId } = await getRazorpayConfig();
          return { alreadyPaid: false as const, orderId: existing.razorpayOrderId, amount: existing.amountPaise, currency: existing.currency, keyId };
        }

        // organizationId is always null for this purpose — RfS Document access is gated by
        // payerEmail (see rfsDocumentAccessService.ts), not by linking the payment to an
        // organization record.
        const created = await createPaymentOrder({
          purpose: 'rfs_document',
          tenderId,
          organizationId: null,
          payerName: parsed.data.payerName,
          payerEmail,
          payerCompany: parsed.data.company,
          payerDesignation: parsed.data.designation,
          payerMobile: parsed.data.mobile,
          payerIsGenerator: parsed.data.isGenerator,
          consentGivenAt: new Date(),
          notes: parsed.data.notes ?? null,
        });
        return { alreadyPaid: false as const, ...created };
      });

      if (result.alreadyPaid) {
        return res.status(409).json({ success: false, error: "You've already purchased this tender's RfS Document" });
      }
      const { alreadyPaid: _alreadyPaid, ...rest } = result;
      res.json({ success: true, ...rest });
    } catch (err) {
      if (err instanceof LockContentionError) {
        return res.status(409).json({ success: false, error: 'A payment request for this document is already being processed — please wait a moment and try again.' });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// Authenticated — the Bid Processing Fee requires a real, logged-in organization. organizationId
// always comes from the verified token, NEVER from the request body — otherwise any caller could
// create a payment order that looks like it belongs to a different org.
router.post('/payment/orders', orderLimiter, ...authRequired(), async (req, res, next) => {
  try {
    const parsed = orgOrderBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }

    const tender = await Tender.findByPk(parsed.data.tenderId);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });

    const lockKey = `payment-order-lock:${parsed.data.purpose}:${parsed.data.tenderId}:org${req.org!.id}`;
    try {
      const result = await withLock(lockKey, PAYMENT_ORDER_LOCK_TTL_MS, async () => {
        // De-dup guard, same as the rfs-document route above — without this, a retried/double-
        // clicked frontend request (or a browser tab closed and reopened before the first order's
        // /verify call resolved) could spawn a second Razorpay order, and be charged twice, for the
        // same fee. Not in a terminal 'failed' state means 'created'/'attempted'/'paid' — a failed
        // attempt doesn't block a genuine retry. Run inside the lock above so a second concurrent
        // request can't read "nothing exists yet" before the first one's Payment.create has landed.
        const existing = await Payment.findOne({
          where: { tenderId: parsed.data.tenderId, organizationId: req.org!.id, purpose: parsed.data.purpose, status: { [Op.ne]: 'failed' } },
          order: [['id', 'DESC']],
        });
        if (existing) {
          if (existing.status === 'paid') {
            return { alreadyPaid: true as const };
          }
          // Still in progress ('created'/'attempted') — resume that same order rather than
          // spawning a second one; the frontend's checkout flow behaves identically either way.
          const { keyId } = await getRazorpayConfig();
          return { alreadyPaid: false as const, orderId: existing.razorpayOrderId, amount: existing.amountPaise, currency: existing.currency, keyId };
        }

        const created = await createPaymentOrder({
          purpose: parsed.data.purpose,
          tenderId: parsed.data.tenderId,
          organizationId: req.org!.id,
          payerName: null,
          payerEmail: null,
          notes: null,
        });
        return { alreadyPaid: false as const, ...created };
      });

      if (result.alreadyPaid) {
        return res.status(409).json({ success: false, error: 'This fee has already been paid' });
      }
      const { alreadyPaid: _alreadyPaid, ...rest } = result;
      res.json({ success: true, ...rest });
    } catch (err) {
      if (err instanceof LockContentionError) {
        return res.status(409).json({ success: false, error: 'A payment request for this fee is already being processed — please wait a moment and try again.' });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

// Signature verification — the browser-side completion of checkout. This is NOT the source of
// truth (Section 6's webhook is); it exists so the UI can show a result immediately instead of
// waiting for a webhook that may take a few seconds. Fulfilment (marking the order paid) also
// happens here on a valid signature, same as the webhook would independently do if this call never
// arrived — see processPaymentCaptured's idempotency for why both paths converging safely matters.
router.post('/payment/verify', verifyLimiter, async (req, res, next) => {
  try {
    const parsed = verifyBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = parsed.data;

    const payment = await Payment.findOne({ where: { razorpayOrderId } });
    if (!payment) return res.status(404).json({ success: false, error: 'No payment order found' });

    // Idempotent: a repeat call for an already-paid order (e.g. the user's browser retries the
    // verify request) must not re-process anything — just confirm success again. A payment already
    // in a TERMINAL state (failed/refunded) is rejected outright rather than re-attempting the HMAC
    // check — isLegalTransition(x, x) is deliberately true for same-state idempotency elsewhere
    // (the webhook handlers), which is exactly why it's the wrong check here: it would let an
    // already-failed payment fall through to a pointless repeat signature check instead of the 409
    // this state genuinely warrants.
    if (payment.status === 'paid') {
      return res.json({ success: true, status: 'paid' });
    }
    if (payment.status === 'failed' || payment.status === 'refunded') {
      return res.status(409).json({ success: false, error: `Payment is already ${payment.status} — cannot verify` });
    }

    // HMAC over OUR DB's own razorpayOrderId, not req.body's — the lookup above already confirmed
    // this Payment row exists and is the one this call is verifying against; using anything else
    // here would defeat the point of looking it up first.
    const isValid = await verifyCallback({ orderId: payment.razorpayOrderId, paymentId: razorpayPaymentId, signature: razorpaySignature });

    if (!isValid) {
      await transitionPayment(payment, 'failed');
      logger.error(
        { reqId: req.requestId, paymentId: payment.id, razorpayOrderId, razorpayPaymentId },
        '[PAYMENT] signature verification failed — marked failed, nothing fulfilled'
      );
      return res.status(400).json({ success: false, error: 'Signature verification failed' });
    }

    await transitionPayment(payment, 'paid', { razorpayPaymentId, razorpaySignature });
    logger.info({ reqId: req.requestId, paymentId: payment.id, razorpayOrderId, razorpayPaymentId }, '[PAYMENT] verified and marked paid');

    res.json({ success: true, status: 'paid' });
  } catch (err) {
    next(err);
  }
});

// Invoice retrieval (Red Flag #6) — a short-lived signed URL, matching the plan's "accessed only
// via short-lived signed URLs" storage spec for any document. Ownership check differs by payment
// shape, same distinction Payment itself draws: an org-linked payment (bid_processing) requires
// that org's auth token; an account-less rfs_document payment has no organizationId to check
// against, so it's gated on the same payerEmail traceability the plan already accepts as
// proportionate for that account-less Stage 3 flow (see rfsDocumentAccessService.ts's identical
// reasoning).
const invoiceLimiter = rateLimit({ name: 'payments:invoice', windowMs: 60 * 1000, limit: 30 });

router.get('/payment/:id/invoice', invoiceLimiter, optionalAuth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid payment id' });

    const payment = await Payment.findByPk(id);
    if (!payment) return res.status(404).json({ success: false, error: 'Payment not found' });

    if (payment.organizationId !== null) {
      if (!req.org || req.org.id !== payment.organizationId) {
        return res.status(403).json({ success: false, error: 'Not authorized to view this invoice' });
      }
    } else {
      const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : undefined;
      if (!email || email !== payment.payerEmail?.toLowerCase()) {
        return res.status(403).json({ success: false, error: 'Not authorized to view this invoice' });
      }
    }

    const invoice = await Invoice.findOne({ where: { paymentId: id } });
    // Accurate, not just optimistic wording: invoiceService.ts's self-healing check retries any
    // paid payment missing an invoice every 15 minutes, so "not yet" really does mean "check back
    // shortly," not a silent permanent failure with no automatic recovery.
    if (!invoice) return res.status(404).json({ success: false, error: 'No invoice has been generated for this payment yet — check back shortly' });

    const url = await getSignedDownloadUrl(invoice.s3Key);
    res.json({ success: true, invoiceNumber: invoice.invoiceNumber, isTaxInvoice: Boolean(invoice.sellerGstin), url });
  } catch (err) {
    next(err);
  }
});

// TODO(deploy): register this exact URL in the Razorpay dashboard once a public URL exists.
// Test mode and live mode use SEPARATE webhook secrets — re-set RAZORPAY_WEBHOOK_SECRET when
// switching modes, it does not carry over.
//
// This is the real source of truth for payment completion — unlike /payment/verify (which only
// runs if the browser's callback actually fires), Razorpay retries this delivery independently of
// anything happening client-side, so it's the path that survives a dropped connection between
// checkout and the browser calling /verify. Deliberately does NOT require the org/buyer auth used
// elsewhere in this file — Razorpay itself is the caller, authenticated by the signature check
// below, not a bearer token.
const webhookLimiter = rateLimit({ name: 'payments:webhook', windowMs: 60 * 1000, limit: 120 });

router.post('/payment/webhook', webhookLimiter, async (req, res) => {
  // req.rawBody is populated by index.ts's express.json({ verify }) — see that file's comment.
  // Falling back to JSON.stringify(req.body) would NOT be safe here (re-serialization is not
  // guaranteed byte-identical to what Razorpay actually signed) — if rawBody is somehow missing,
  // treat that as a signature failure rather than silently trusting the parsed body.
  const rawBody = req.rawBody;
  const signature = req.headers['x-razorpay-signature'];
  const signatureHeader = typeof signature === 'string' ? signature : undefined;

  logger.info({ reqId: req.requestId, event: req.body?.event, hasSignature: Boolean(signatureHeader) }, '[WEBHOOK] received');

  const isValid = rawBody ? await verifyWebhookSignature(rawBody, signatureHeader) : false;
  if (!isValid) {
    logger.error({ reqId: req.requestId, event: req.body?.event }, '[WEBHOOK] signature verification failed — rejecting, nothing processed');
    return res.status(400).json({ success: false, error: 'Invalid webhook signature' });
  }

  // Respond fast, process after — today's handlers are a single fast UPDATE each, so there's
  // nothing genuinely "heavy" to defer to a queue yet, but responding first (rather than awaiting
  // the handler before res.json) means a slow DB moment on our end can never turn into Razorpay
  // seeing a timeout and retrying a delivery we actually did receive and are still processing.
  res.json({ success: true });

  try {
    const event = req.body?.event;
    switch (event) {
      case 'payment.captured':
        await processPaymentCaptured(req.body.payload.payment.entity);
        break;
      case 'payment.failed':
        await processPaymentFailed(req.body.payload.payment.entity);
        break;
      case 'refund.processed':
        await processRefundProcessed(req.body.payload.refund.entity);
        break;
      case 'refund.failed':
        await processRefundFailed(req.body.payload.refund.entity);
        break;
      default:
        logger.info({ reqId: req.requestId, event }, '[WEBHOOK] unhandled event type — ignored');
    }
  } catch (err) {
    logger.error({ reqId: req.requestId, err }, '[WEBHOOK] handler threw after responding 200 — Razorpay will not retry this delivery');
  }
});

// Admin-only reconciliation — no dedicated background job queue exists yet (see the tech-stack
// plan's "worth adding" note), so this is the "admin endpoint" half of Section 7's stated
// alternatives, same admin-org-token pattern used throughout this codebase (tenders.ts,
// tenderDocuments.ts, emdSubmissions.ts). Finds every payment stuck in 'created' for more than 30
// minutes and asks Razorpay directly what actually happened to it.
const reconcileLimiter = rateLimit({ name: 'payments:reconcile', windowMs: 60 * 1000, limit: 10 });

router.post('/payment/reconcile', reconcileLimiter, ...authRequired('admin'), async (req, res, next) => {
  try {
    const result = await reconcileStalePayments();
    logger.info({ reqId: req.requestId, ...result }, '[PAYMENT] reconciliation run');
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// Admin-only refund — same admin-org-token pattern used throughout this codebase. Only a 'paid'
// payment can be refunded — enforced through the shared state machine, not a bespoke check here, so
// this stays consistent with every other transition in the module. amountPaise is optional: omit it
// for a full refund, or provide it for a partial one — passed straight through to Razorpay, which
// validates it against the original captured amount itself.
const refundBodySchema = z
  .object({
    amountPaise: z.number().int().positive().optional(),
  })
  .strict();

const refundLimiter = rateLimit({ name: 'payments:refund', windowMs: 60 * 1000, limit: 10 });

router.post('/payment/:id/refund', refundLimiter, ...authRequired('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid payment id' });

    const parsed = refundBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }

    const payment = await Payment.findByPk(id);
    if (!payment) return res.status(404).json({ success: false, error: 'Payment not found' });

    const outcome = await refundPayment(payment, parsed.data.amountPaise);
    if (!outcome.ok) {
      const statusCode = outcome.reason === 'razorpay_rejected' ? 502 : 409;
      return res.status(statusCode).json({ success: false, error: outcome.message });
    }

    res.json({ success: true, refundId: outcome.refundId, status: outcome.status });
  } catch (err) {
    next(err);
  }
});

export default router;
