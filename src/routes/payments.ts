import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Op } from 'sequelize';
import { Payment, type PaymentPurpose } from '../models/Payment.js';
import { Tender } from '../models/Tender.js';
import { computeAmountPaise } from '../services/pricingService.js';
import { createOrder, verifyCallback, verifyWebhookSignature, refund as razorpayRefund } from '../lib/razorpayAdapter.js';
import { processPaymentCaptured, processPaymentFailed, processRefundProcessed } from '../services/paymentWebhookService.js';
import { transitionPayment } from '../services/paymentStateMachine.js';
import { reconcileStalePayments } from '../services/paymentReconciliationService.js';
import { getRazorpayConfig } from '../lib/razorpayConfig.js';
import { verifyOrgToken, type OrgTokenPayload } from '../lib/orgAuth.js';
import { Invoice } from '../models/Invoice.js';
import { getSignedDownloadUrl } from '../lib/s3.js';
import { logger } from '../lib/logger.js';

const router = Router();

const MAX_STRING_FIELD_LENGTH = 255;
const orderLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

function extractBearerToken(authHeader: string | undefined): string | undefined {
  return authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
}

async function requireOrgAuth(authHeader: string | undefined): Promise<OrgTokenPayload | null> {
  const token = extractBearerToken(authHeader);
  if (!token) return null;
  try {
    return await verifyOrgToken(token);
  } catch {
    return null;
  }
}

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
    purpose: z.enum(['bid_processing', 'emd', 'success_charge']),
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

const verifyLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

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

    // De-dup guard: without this, the same person (or a retried/double-clicked frontend request)
    // could be charged twice for the same tender's document. Not in a terminal 'failed' state means
    // 'created'/'attempted'/'paid' — a failed attempt doesn't block a genuine retry.
    const existing = await Payment.findOne({
      where: { tenderId, payerEmail, purpose: 'rfs_document', status: { [Op.ne]: 'failed' } },
      order: [['id', 'DESC']],
    });
    if (existing) {
      if (existing.status === 'paid') {
        return res.status(409).json({ success: false, error: "You've already purchased this tender's RfS Document" });
      }
      // Still in progress ('created'/'attempted') — resume that same order rather than spawning a
      // second one; the frontend's checkout flow behaves identically either way.
      const { keyId } = await getRazorpayConfig();
      return res.json({ success: true, orderId: existing.razorpayOrderId, amount: existing.amountPaise, currency: existing.currency, keyId });
    }

    // organizationId is always null for this purpose — RfS Document access is gated by payerEmail
    // (see rfsDocumentAccessService.ts), not by linking the payment to an organization record.
    const result = await createPaymentOrder({
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

    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// Authenticated — Bid Processing Fee, EMD, and success charge all require a real, logged-in
// organization. organizationId always comes from the verified token, NEVER from the request body —
// otherwise any caller could create a payment order that looks like it belongs to a different org.
router.post('/payment/orders', orderLimiter, async (req, res, next) => {
  try {
    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });

    const parsed = orgOrderBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }

    const tender = await Tender.findByPk(parsed.data.tenderId);
    if (!tender) return res.status(404).json({ success: false, error: 'Tender not found' });

    const result = await createPaymentOrder({
      purpose: parsed.data.purpose,
      tenderId: parsed.data.tenderId,
      organizationId: payload.organizationId,
      payerName: null,
      payerEmail: null,
      notes: null,
    });

    res.json({ success: true, ...result });
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
// shape, same distinction Payment itself draws: an org-linked payment (bid_processing/emd/
// success_charge) requires that org's auth token; an account-less rfs_document payment has no
// organizationId to check against, so it's gated on the same payerEmail traceability the plan
// already accepts as proportionate for that account-less Stage 3 flow (see
// rfsDocumentAccessService.ts's identical reasoning).
const invoiceLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

router.get('/payment/:id/invoice', invoiceLimiter, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid payment id' });

    const payment = await Payment.findByPk(id);
    if (!payment) return res.status(404).json({ success: false, error: 'Payment not found' });

    if (payment.organizationId !== null) {
      const payload = await requireOrgAuth(req.headers.authorization);
      if (!payload || payload.organizationId !== payment.organizationId) {
        return res.status(403).json({ success: false, error: 'Not authorized to view this invoice' });
      }
    } else {
      const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : undefined;
      if (!email || email !== payment.payerEmail?.toLowerCase()) {
        return res.status(403).json({ success: false, error: 'Not authorized to view this invoice' });
      }
    }

    const invoice = await Invoice.findOne({ where: { paymentId: id } });
    if (!invoice) return res.status(404).json({ success: false, error: 'No invoice has been generated for this payment yet' });

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
const webhookLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });

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
      default:
        logger.info({ reqId: req.requestId, event }, '[WEBHOOK] unhandled event type — ignored');
    }
  } catch (err) {
    logger.error({ reqId: req.requestId, err }, '[WEBHOOK] handler threw after responding 200 — Razorpay will not retry this delivery');
  }
});

// Admin-triggered reconciliation — no dedicated background job queue exists yet (see the tech-stack
// plan's "worth adding" note), so this is the "admin endpoint" half of Section 7's stated
// alternatives, same unauthenticated-admin-action pattern already used elsewhere in this codebase
// (auctionAdmin.ts, tenders.ts's settle-winner/declare-default). Finds every payment stuck in
// 'created' for more than 30 minutes and asks Razorpay directly what actually happened to it.
const reconcileLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

router.post('/payment/reconcile', reconcileLimiter, async (req, res, next) => {
  try {
    const result = await reconcileStalePayments();
    logger.info({ reqId: req.requestId, ...result }, '[PAYMENT] reconciliation run');
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

// Admin-only refund — same unauthenticated-admin-action pattern used throughout this file (there is
// no real admin auth mechanism built yet, see AUTH_STRATEGY_DECISIONS.md). Only a 'paid' payment can
// be refunded — enforced through the shared state machine, not a bespoke check here, so this stays
// consistent with every other transition in the module. amountPaise is optional: omit it for a full
// refund, or provide it for a partial one — passed straight through to Razorpay, which validates it
// against the original captured amount itself.
const refundBodySchema = z
  .object({
    amountPaise: z.number().int().positive().optional(),
  })
  .strict();

const refundLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

router.post('/payment/:id/refund', refundLimiter, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid payment id' });

    const parsed = refundBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }

    const payment = await Payment.findByPk(id);
    if (!payment) return res.status(404).json({ success: false, error: 'Payment not found' });
    if (payment.status !== 'paid') {
      return res.status(409).json({ success: false, error: `Cannot refund a payment in status '${payment.status}' — only a paid payment can be refunded` });
    }
    if (!payment.razorpayPaymentId) {
      // Should be unreachable (status is only ever 'paid' alongside a recorded payment id), but a
      // refund call needs a real Razorpay payment id to act on — fail loudly rather than send a
      // malformed request to Razorpay if this invariant is ever somehow violated.
      return res.status(409).json({ success: false, error: 'Payment has no recorded razorpayPaymentId — cannot refund' });
    }

    let result;
    try {
      result = await razorpayRefund({ paymentId: payment.razorpayPaymentId, amountPaise: parsed.data.amountPaise });
    } catch (err) {
      // A rejection from Razorpay itself (bad payment id, already fully refunded, insufficient
      // account balance) is an expected, legitimate outcome — not a bug in this server. Surfacing
      // it as a clear 502 with Razorpay's own description gives an admin something actionable,
      // instead of the generic 500 the catch-all error handler would otherwise produce.
      const description = (err as { error?: { description?: string } })?.error?.description;
      logger.error({ reqId: req.requestId, paymentId: payment.id, razorpayPaymentId: payment.razorpayPaymentId, err }, '[PAYMENT] refund rejected by Razorpay');
      return res.status(502).json({ success: false, error: description || 'Razorpay rejected this refund request' });
    }

    await payment.update({ razorpayRefundId: result.refundId });

    // Instant refunds (most methods) come back already 'processed' — transition right away rather
    // than waiting on a webhook that, for these, may never meaningfully add information. Pending
    // refunds (some bank-transfer methods) stay 'paid' until the refund.processed webhook (Section
    // 6) confirms completion — transitionPayment's own idempotency means whichever path fires first
    // wins and the other is a safe no-op, exactly like every other dual browser/webhook path here.
    if (result.status === 'processed') {
      await transitionPayment(payment, 'refunded');
    }

    logger.info(
      { reqId: req.requestId, paymentId: payment.id, refundId: result.refundId, razorpayStatus: result.status, amountPaise: parsed.data.amountPaise ?? payment.amountPaise },
      '[PAYMENT] refund initiated'
    );

    res.json({ success: true, refundId: result.refundId, status: result.status });
  } catch (err) {
    next(err);
  }
});

export default router;
