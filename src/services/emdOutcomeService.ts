import { EmdSubmission } from '../models/EmdSubmission.js';
import { logger } from '../lib/logger.js';

// EMD is a physical/scanned Bank Guarantee (see EmdSubmission), not money — there is no Razorpay
// call anywhere in this file any more. Both outcomes are real-world actions on a physical
// instrument (return it, or invoke it with the issuing bank), so both are explicit, admin-triggered
// actions with a required reason — there is no automatic trigger for either one, unlike the old
// money-based version of this service.

export type EmdResolution =
  | { ok: true }
  | { ok: false; reason: 'not_found' | 'already_resolved' };

// Marks a generator's submitted BG as physically returned. dispatchReference is optional — not
// every dispatch method (e.g. hand delivery) produces a tracking number.
export async function releaseEmd(
  tenderId: number,
  organizationId: number,
  reason: string,
  dispatchReference?: string
): Promise<EmdResolution> {
  const submission = await EmdSubmission.findOne({ where: { tenderId, organizationId } });
  if (!submission) return { ok: false, reason: 'not_found' };
  if (submission.status !== 'submitted') return { ok: false, reason: 'already_resolved' };

  await submission.update({
    status: 'released',
    resolvedAt: new Date(),
    resolvedReason: reason,
    dispatchReference: dispatchReference ?? null,
  });
  logger.info({ tenderId, organizationId, reason }, '[EMD] released');
  return { ok: true };
}

// Marks a generator's submitted BG as invoked with the issuing bank — the document is not returned.
export async function invokeEmd(tenderId: number, organizationId: number, reason: string): Promise<EmdResolution> {
  const submission = await EmdSubmission.findOne({ where: { tenderId, organizationId } });
  if (!submission) return { ok: false, reason: 'not_found' };
  if (submission.status !== 'submitted') return { ok: false, reason: 'already_resolved' };

  await submission.update({ status: 'invoked', resolvedAt: new Date(), resolvedReason: reason });
  logger.info({ tenderId, organizationId, reason }, '[EMD] invoked');
  return { ok: true };
}
