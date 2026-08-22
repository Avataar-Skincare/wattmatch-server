import { TenderInvitation } from '../models/TenderInvitation.js';
import { VettingBid } from '../models/VettingBid.js';
import { logger } from '../lib/logger.js';

// EMD outcome tracking per TENDER_WORKFLOW_STAKEHOLDER_PLAN.md's Stage 8 matrix. No payment module
// exists yet, so these functions only record the DECISION (pending/refunded/forfeited) on the
// invitation row — they do not move real money. Once Razorpay/EMD payment lands, the actual
// refund/capture call belongs right where refundEmd/forfeitEmd are invoked below, not as a separate
// reconciliation step bolted on later.

export async function refundEmd(tenderId: number, organizationId: number, reason: string): Promise<void> {
  const invitation = await TenderInvitation.findOne({ where: { tenderId, organizationId } });
  if (!invitation || invitation.emdOutcome !== 'pending') return; // already settled, or never invited — don't overwrite a real outcome
  await invitation.update({ emdOutcome: 'refunded', emdOutcomeAt: new Date(), emdOutcomeReason: reason });
  logger.info({ tenderId, organizationId, reason }, '[EMD] refund recorded');
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
