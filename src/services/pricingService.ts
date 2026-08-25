import { Tender } from '../models/Tender.js';
import { Organization } from '../models/Organization.js';
import type { PaymentPurpose } from '../models/Payment.js';

// Single source of truth for money — every amount charged anywhere in the payment module comes
// from here, never from client input. Per TENDER_WORKFLOW_STAKEHOLDER_PLAN.md, fees vary tender to
// tender, so each amount is read directly off the Tender row itself — set deliberately by the
// admin who creates it (routes/tenders.ts's admin-only POST /tenders), not computed by a formula
// here. The DB lookups this function already did are what make that possible: when a genuinely
// dynamic formula (e.g. a per-MW EMD rate against the generator's declared capacity) is wanted
// later, it reads from the same `tender`/`organization` records already being fetched here — no
// caller of computeAmountPaise() needs to change either way.

export interface PricingContext {
  purpose: PaymentPurpose;
  tenderId: number;
  organizationId?: number;
}

// GST is deliberately NOT applied here — Red Flag #6 (GST invoicing) is a separate, not-yet-built
// concern about the INVOICE issued after payment, not the amount charged. Keeping this function's
// return value the pre-tax base amount means tax treatment can be layered on at invoicing time
// without this function (or any of its callers) changing shape.
export async function computeAmountPaise(context: PricingContext): Promise<number> {
  const tender = await Tender.findByPk(context.tenderId);
  if (!tender) throw new Error(`computeAmountPaise: tender ${context.tenderId} not found`);

  const organization = context.organizationId ? await Organization.findByPk(context.organizationId) : null;

  switch (context.purpose) {
    case 'rfs_document':
      return computeRfsDocumentFeePaise(tender);
    case 'bid_processing':
      return computeBidProcessingFeePaise(tender, organization);
    default: {
      const exhaustiveCheck: never = context.purpose;
      throw new Error(`computeAmountPaise: unhandled purpose ${exhaustiveCheck as string}`);
    }
  }
}

function computeRfsDocumentFeePaise(tender: Tender): number {
  return tender.rfsDocumentFeePaise;
}

// Flat per-tender amount, deliberately simpler than the plan's own reference to a per-MW rate
// against the generator's quoted capacity — the admin sets one number per tender rather than a
// formula. Revisit if a genuinely dynamic, capacity-scaled rate is ever wanted; the organization
// lookup already happening in computeAmountPaise is what a future formula would need.
function computeBidProcessingFeePaise(tender: Tender, _organization: Organization | null): number {
  return tender.bidProcessingFeePaise;
}
