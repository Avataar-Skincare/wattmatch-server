import { Payment } from '../models/Payment.js';

// Single source of truth for "has this email paid the RfS Document (Bid Purchase) fee for this
// tender" — TENDER_WORKFLOW_STAKEHOLDER_PLAN.md Stage 3/4: this applies to EVERY generator
// regardless of how they reached the tender (auto-matched invitation or open self-enroll) — being
// invited only means "come consider this tender," it does not exempt anyone from the fee.
//
// Keyed by email, not organizationId: the RfS Document purchase (Stage 3) is deliberately
// account-less — someone can pay before ever registering an organization. Tying the check to
// organizationId would require "claiming" each anonymous payment onto an org record after the
// fact (at purchase time if the org already existed, or at registration time if it didn't),
// which is real, permanent extra state to keep in sync for no benefit — the email the payment was
// made under IS the identity that matters here. Comparison is case-insensitive to match
// Organization.contactEmail and Payment.payerEmail, both of which are lowercased at the point
// they're written (organizations.ts / payments.ts's zod schemas).
export async function hasRfsDocumentPaid(tenderId: number, email: string): Promise<boolean> {
  const payment = await Payment.findOne({
    where: { tenderId, payerEmail: email.trim().toLowerCase(), purpose: 'rfs_document', status: 'paid' },
  });
  return payment !== null;
}
