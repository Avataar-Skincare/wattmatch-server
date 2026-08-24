import { TenderInvitation } from '../models/TenderInvitation.js';
import { VettingBid } from '../models/VettingBid.js';
import { Payment } from '../models/Payment.js';
import { refundPayment } from './paymentRefundService.js';
import { logger } from '../lib/logger.js';

// EMD outcome tracking per TENDER_WORKFLOW_STAKEHOLDER_PLAN.md's Stage 8 matrix, recorded on the
// invitation row. refundEmd now actually moves money (via the same refundPayment() the admin
// refund route uses) — forfeitEmd never needs to call Razorpay at all: forfeiture just means "keep
// the already-captured payment," which requires no further action.

// Idempotency note: the `emdOutcome !== 'pending'` guard correctly prevents a second call once the
// first has recorded an outcome, covering every real call pattern in this codebase (auction close,
// settle-winner, declare-default — none of which fire concurrently for the same invitation in
// practice). It does not close a theoretical race between two near-simultaneous calls that both
// read 'pending' before either writes — accepted as a low-probability, bounded residual risk rather
// than adding a distributed lock for a scenario nothing here actually triggers.
// Returns whether the EMD was actually refunded — callers that report their own outcome to a user
// or a log line (e.g. tenders.ts's settle-winner) should reflect this rather than assuming success,
// since a call that returns without throwing is not the same as money having actually moved.
export async function refundEmd(tenderId: number, organizationId: number, reason: string): Promise<boolean> {
  const invitation = await TenderInvitation.findOne({ where: { tenderId, organizationId } });
  if (!invitation) return false;
  if (invitation.emdOutcome !== 'pending') return invitation.emdOutcome === 'refunded'; // already settled — report what it actually settled as, don't overwrite

  const emdPayment = await Payment.findOne({ where: { tenderId, organizationId, purpose: 'emd', status: 'paid' } });
  if (!emdPayment) {
    // Should be unreachable — bid submission is gated on a paid EMD (vettingBids.ts) — but refusing
    // to silently mark "refunded" when there is nothing to actually refund is the honest behavior:
    // leave the outcome 'pending' so this is visible and investigable, not quietly wrong.
    logger.error({ tenderId, organizationId, reason }, '[EMD] no paid EMD payment found to refund — outcome left pending for manual investigation');
    return false;
  }

  const outcome = await refundPayment(emdPayment);
  if (!outcome.ok) {
    logger.error({ tenderId, organizationId, reason, refundReason: outcome.reason, message: outcome.message }, '[EMD] refund attempt failed — outcome left pending for manual investigation');
    return false;
  }

  await invitation.update({ emdOutcome: 'refunded', emdOutcomeAt: new Date(), emdOutcomeReason: reason });
  logger.info({ tenderId, organizationId, reason, refundId: outcome.refundId }, '[EMD] refund recorded');
  return true;
}

export async function forfeitEmd(tenderId: number, organizationId: number, reason: string): Promise<void> {
  const invitation = await TenderInvitation.findOne({ where: { tenderId, organizationId } });
  if (!invitation || invitation.emdOutcome !== 'pending') return;
  await invitation.update({ emdOutcome: 'forfeited', emdOutcomeAt: new Date(), emdOutcomeReason: reason });
  logger.info({ tenderId, organizationId, reason }, '[EMD] forfeiture recorded');
}

// Called when an auction closes for a tender's approved generators — refunds everyone who wasn't
// the winner immediately (they're done, no further outcome pending), and leaves the winner's EMD
// 'pending' until the winner's success-charge outcome is settled (see the settle-winner route in
// tenders.ts) — matching the plan's matrix exactly: only backing out of success charges forfeits
// the EMD, not simply losing the auction.
//
// winnerAlias is matched against VettingBid.applicantAlias — a placeholder correlation (same
// caveat as vettingAuctionBridge.ts's organizationName placeholder) since AuctionParticipant has no
// direct organizationId link back to the generator org; fine for now since applicantAlias is
// already derived from the real org name at submission time (see vettingBids.ts).
export async function processAuctionCloseEmdOutcomes(tenderRef: string, winnerAlias: string | null): Promise<void> {
  const tenderId = Number(tenderRef);
  if (!Number.isFinite(tenderId)) return; // not a real tender-backed auction (e.g. a manually seeded demo auction) — nothing to settle

  const approvedBids = await VettingBid.findAll({ where: { tenderRef, technicalStatus: 'approved' } });
  for (const bid of approvedBids) {
    if (!bid.generatorOrgId) continue;
    if (bid.applicantAlias === winnerAlias) continue; // winner settles separately, once success charges are resolved
    await refundEmd(tenderId, bid.generatorOrgId, 'Approved but did not win the auction');
  }
}
