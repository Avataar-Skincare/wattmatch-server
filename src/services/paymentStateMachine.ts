import type { Payment, PaymentStatus } from '../models/Payment.js';
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
  paid: ['refunded'],
  failed: [],
  refunded: [],
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

  await payment.update({ status: to, ...extra });
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
