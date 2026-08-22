import { Tender } from '../models/Tender.js';
import { Organization } from '../models/Organization.js';
import type { PaymentPurpose } from '../models/Payment.js';

// Single source of truth for money — every amount charged anywhere in the payment module comes
// from here, never from client input. The commission/fee model isn't finalized yet
// (TENDER_WORKFLOW_STAKEHOLDER_PLAN.md's fee sections describe the SHAPE — per-MW EMD rates,
// flat processing fees — but no final numbers), so every purpose below is stubbed to a flat ₹1
// pending that decision. The DB lookups are real and stay in place regardless: when real formulas
// land, they read from the same `tender`/`organization` records already being fetched here — no
// caller of computeAmountPaise() needs to change.
//
// TODO(pricing): replace every STUB_AMOUNT_PAISE return below with the real formula once the
// commission model is finalized. Nothing else in the payment module should need to change when
// that happens — that's the point of funneling every amount through this one function.

const STUB_AMOUNT_PAISE = 100; // ₹1 — deliberately obvious placeholder, not a real fee

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
    case 'emd':
      return computeEmdPaise(tender, organization);
    case 'success_charge':
      return computeSuccessChargePaise(tender, organization);
    default: {
      const exhaustiveCheck: never = context.purpose;
      throw new Error(`computeAmountPaise: unhandled purpose ${exhaustiveCheck as string}`);
    }
  }
}

// TODO(pricing): flat fee, likely tender-independent — confirm once decided.
function computeRfsDocumentFeePaise(_tender: Tender): number {
  return STUB_AMOUNT_PAISE;
}

// TODO(pricing): plan references a per-MW rate against the generator's QUOTED capacity, capped —
// see TENDER_WORKFLOW_STAKEHOLDER_PLAN.md's Payment & EMD data model (Bid Processing Fee).
function computeBidProcessingFeePaise(_tender: Tender, _organization: Organization | null): number {
  return STUB_AMOUNT_PAISE;
}

// TODO(pricing): real EMD is capacity-based and technology-dependent (separate solar/wind/ESS
// rates per the tender spec's precedent) — needs the organization's declared technology mix, which
// isn't captured on Organization yet (only a single capacityMw field exists today).
function computeEmdPaise(_tender: Tender, _organization: Organization | null): number {
  return STUB_AMOUNT_PAISE;
}

// TODO(pricing): success charge is two installments per the plan (50% within 30 days of award,
// 50% before PPA execution) — this function currently prices a single full charge; splitting into
// installments is a caller-side concern once the schedule is decided, not this function's.
function computeSuccessChargePaise(_tender: Tender, _organization: Organization | null): number {
  return STUB_AMOUNT_PAISE;
}
