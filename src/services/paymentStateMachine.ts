import { Payment, type PaymentStatus } from '../models/Payment.js';
import { Tender } from '../models/Tender.js';
import { generateInvoiceForPayment } from './invoiceService.js';
import { sendTenderDocumentEmail } from './email.js';
import { readObject } from '../lib/s3.js';
import { logger } from '../lib/logger.js';

// Single source of truth for which Payment.status transitions are legal — /payment/verify, the
// webhook handlers, and the reconciliation job all go through this instead of each independently
// re-deriving "is this transition okay" (which is exactly how that logic ended up slightly
// different in each place before this existed). 'created' is allowed to go straight to 'paid' or
// 'failed', not just through 'attempted' — nothing in this codebase currently has a signal for the
// 'attempted' state (no `payment.authorized` webhook handler exists yet), so requiring it as a
// mandatory hop would make every real transition today "illegal" against the letter of the state
// diagram. 'attempted' stays a legal stop for when that signal exists, it's just not mandatory yet.
const LEGAL_TRANSITIONS: Record<PaymentStatus, PaymentStatus[]> = {
  created: ['attempted', 'paid', 'failed'],
  attempted: ['paid', 'failed'],
  paid: ['refunded', 'partially_refunded'],
  // 'failed' -> 'paid' exists for one specific case: /payment/verify's own HMAC check locally
  // marking a payment 'failed' before Razorpay's later, authoritative payment.captured webhook
  // arrives for the same (actually successful) payment. Without this, that webhook's own call to
  // transitionPayment would be silently rejected as illegal, permanently stranding a real payment
  // as "failed" with no recovery path — see paymentWebhookService.ts's processPaymentCaptured. Safe
  // to allow because the only caller that can reach 'paid' is the webhook path, itself gated on
  // verifyWebhookSignature — a client can't trigger this transition by simply re-calling /verify
  // (that route already rejects outright on a 'failed' status; see its own comment).
  failed: ['paid'],
  refunded: [],
  // A partial refund can be topped up by a further (partial or full) refund.
  partially_refunded: ['refunded', 'partially_refunded'],
};

// A pure lookup, deliberately with NO same-state special case: from === to is a no-op, not a
// transition, and is handled by transitionPayment() below before this is ever consulted — folding
// that idempotency shortcut in here as well was tried and caused a real bug (see git history / the
// /payment/verify route's own comment): a second caller used this function to ask "is this payment
// already terminal", where from === to === 'failed' returning true meant an already-failed payment
// wrongly passed as "fine to re-verify" instead of being rejected. Keep this a plain, honest table.
export function isLegalTransition(from: PaymentStatus, to: PaymentStatus): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export interface TransitionResult {
  applied: boolean;
  reason?: string;
}

// Applies a transition if (and only if) it's legal; logs and no-ops otherwise rather than throwing
// — callers here are webhook/verify handlers where "reject with an error" already has its own
// specific response shape per call site, so this reports back rather than dictating how the caller
// responds.
export async function transitionPayment(
  payment: Payment,
  to: PaymentStatus,
  extra: Partial<{ razorpayPaymentId: string; razorpaySignature: string }> = {}
): Promise<TransitionResult> {
  const from = payment.status;
  if (from === to) return { applied: false, reason: 'already in this state' };

  if (!isLegalTransition(from, to)) {
    logger.warn({ paymentId: payment.id, from, to }, '[PAYMENT_STATE] rejected illegal transition');
    return { applied: false, reason: `illegal transition: ${from} -> ${to}` };
  }

  // Atomic and conditional on the DB row still being in `from` — not a plain instance.update(),
  // which issues an unconditional `WHERE id = :id` and would let two concurrent deliveries of the
  // same webhook event (Razorpay's API explicitly allows duplicate/at-least-once delivery) both
  // pass the isLegalTransition check above off the same in-memory `from`, then both apply, firing
  // the "paid" side effects (invoice generation, confirmation email) twice. The `WHERE status =
  // :from` clause means only whichever caller's UPDATE actually lands first affects a row; the
  // loser's affectedCount is 0, so it correctly reports back "not applied" instead of repeating a
  // side effect that already happened.
  const [affectedCount] = await Payment.update({ status: to, ...extra }, { where: { id: payment.id, status: from } });
  if (affectedCount === 0) {
    logger.warn({ paymentId: payment.id, from, to }, '[PAYMENT_STATE] lost the race to a concurrent transition — not applied');
    return { applied: false, reason: 'concurrent transition already applied' };
  }
  payment.status = to;
  if (extra.razorpayPaymentId !== undefined) payment.razorpayPaymentId = extra.razorpayPaymentId;
  if (extra.razorpaySignature !== undefined) payment.razorpaySignature = extra.razorpaySignature;
  logger.info({ paymentId: payment.id, from, to }, '[PAYMENT_STATE] transitioned');

  // Fire-and-forget, deliberately not awaited: invoice generation (Red Flag #6 in
  // TENDER_WORKFLOW_STAKEHOLDER_PLAN.md) must never add latency to — or fail — the payment
  // confirmation itself, exactly like auctionSocket.ts's own EMD-outcome hook wraps a non-critical
  // side effect so a bug there can never block the critical path.
  if (to === 'paid') {
    generateInvoiceForPayment(payment).catch((err) => {
      logger.error({ err, paymentId: payment.id }, '[PAYMENT_STATE] invoice generation failed — payment confirmation unaffected');
    });

    // Emails the full tender document the moment the fee that unlocks it clears — the in-app
    // download (RfsDocumentPurchasePage.tsx) already happens client-side right after verify, this is
    // the durable second copy for an account-less purchaser who may not be looking at that tab any
    // more. Fire-and-forget, same reasoning as the invoice above: never adds latency to, or can fail,
    // the payment confirmation itself.
    if (payment.purpose === 'rfs_document' && payment.payerEmail) {
      sendRfsDocumentEmailForPayment(payment).catch((err) => {
        logger.error({ err, paymentId: payment.id }, '[PAYMENT_STATE] tender document email failed — payment confirmation unaffected');
      });
    }
  }

  return { applied: true };
}

// A refund can be confirmed through two independent paths — refundPayment's own synchronous
// 'processed' response from Razorpay, and the refund.processed webhook, which Razorpay may or may
// not also send for the same refund (see paymentRefundService.ts's own comment on why the
// synchronous path can't just be removed in favor of always waiting for the webhook). Both paths
// call this instead of transitioning straight to 'refunded', for two reasons: a partial refund must
// not land on the terminal 'refunded' status (blocking any further refund on the same payment), and
// the same physical refund must not have its amount counted twice if both paths fire for it.
// `notes.appliedRefundIds` is the de-dup guard — a lightweight log of which Razorpay refund ids have
// already been reflected in amountRefundedPaise, since Payment has no separate refunds table.
const APPLY_REFUND_MAX_ATTEMPTS = 5;

export async function applyRefundAmount(payment: Payment, refundId: string, amountPaise: number): Promise<TransitionResult> {
  let current = payment;

  for (let attempt = 0; attempt < APPLY_REFUND_MAX_ATTEMPTS; attempt++) {
    const notes = (current.notes ?? {}) as Record<string, unknown>;
    const appliedRefundIds = Array.isArray(notes.appliedRefundIds) ? (notes.appliedRefundIds as string[]) : [];
    if (appliedRefundIds.includes(refundId)) {
      logger.info({ paymentId: current.id, refundId }, '[PAYMENT_STATE] refund already applied — ignoring duplicate confirmation');
      return { applied: false, reason: 'refund already applied' };
    }

    const fromAmountRefundedPaise = current.amountRefundedPaise;
    const amountRefundedPaise = fromAmountRefundedPaise + amountPaise;
    const nextNotes = { ...notes, appliedRefundIds: [...appliedRefundIds, refundId] };

    // Atomic and conditional on amountRefundedPaise still matching what was just read — the same
    // reasoning as transitionPayment's `WHERE status = :from` above. A plain payment.update() here
    // would let two refunds confirmed concurrently for the same payment (two distinct partial
    // refunds, or this same refund's synchronous confirmation racing its own later webhook) both
    // read the same starting amount and have the second write silently clobber the first's
    // contribution — losing real refunded money from the ledger — instead of the second one
    // detecting the race and retrying against the row's actual current state.
    const [affectedCount] = await Payment.update(
      { amountRefundedPaise, notes: nextNotes },
      { where: { id: current.id, amountRefundedPaise: fromAmountRefundedPaise } }
    );

    if (affectedCount > 0) {
      current.amountRefundedPaise = amountRefundedPaise;
      current.notes = nextNotes;
      const to: PaymentStatus = amountRefundedPaise >= current.amountPaise ? 'refunded' : 'partially_refunded';
      return transitionPayment(current, to);
    }

    logger.warn({ paymentId: current.id, refundId, attempt }, '[PAYMENT_STATE] lost the race updating amountRefundedPaise — retrying against fresh state');
    const fresh = await Payment.findByPk(current.id);
    if (!fresh) return { applied: false, reason: 'payment no longer exists' };
    current = fresh;
  }

  logger.error({ paymentId: current.id, refundId }, '[PAYMENT_STATE] applyRefundAmount exhausted retries under contention — refund not applied');
  return { applied: false, reason: 'exhausted retries under contention' };
}

async function sendRfsDocumentEmailForPayment(payment: Payment): Promise<void> {
  const tender = await Tender.findByPk(payment.tenderId);
  if (!tender || !tender.tenderDocumentS3Key) {
    // Nothing uploaded yet at payment time — no established mechanism in this codebase re-sends it
    // later if admin uploads one afterward; the in-app download path still picks it up whenever it
    // does show up, this email is just the immediate best-effort copy.
    logger.info({ paymentId: payment.id, tenderId: payment.tenderId }, '[PAYMENT_STATE] no tender document to email yet — skipped');
    return;
  }
  const content = await readObject(tender.tenderDocumentS3Key);
  if (!content) {
    logger.error({ paymentId: payment.id, tenderId: payment.tenderId }, '[PAYMENT_STATE] tender document upload record exists but object body is missing — skipped');
    return;
  }
  await sendTenderDocumentEmail(payment.payerEmail as string, tender.title, {
    filename: tender.tenderDocumentOriginalFilename ?? 'tender-document.pdf',
    content,
  });
}
