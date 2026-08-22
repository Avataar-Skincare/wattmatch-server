import { TenderDocumentField, type DocumentEnvelope } from '../models/TenderDocumentField.js';

interface DefaultField {
  envelope: DocumentEnvelope;
  key: string;
  label: string;
  required: boolean;
}

// The default checklist from TENDER_WORKFLOW_STAKEHOLDER_PLAN.md §6.1/6.2, seeded onto every new
// tender. "if applicable"/"where applicable" items are marked optional — an admin can delete any
// of these per tender (§6.3), so this is a starting point, not a fixed schema. Consortium-related
// fields stay optional per Red Flag #7: the paperwork slot exists, but WattMatch hasn't decided to
// actually support consortium bids, so nothing here assumes it does.
const DEFAULT_FIELDS: DefaultField[] = [
  // §6.1 RfS Formats
  { envelope: 'technical', key: 'covering_letter', label: 'Covering Letter (Format 7.1)', required: true },
  { envelope: 'technical', key: 'power_of_attorney', label: 'Power of Attorney (Format 7.2, if applicable)', required: false },
  { envelope: 'technical', key: 'emd_instrument_format', label: 'EMD Instrument Format (7.3A/B/C)', required: true },
  { envelope: 'technical', key: 'board_resolutions', label: 'Board Resolutions (Format 7.4)', required: true },
  { envelope: 'technical', key: 'consortium_agreement', label: 'Consortium Agreement (Format 7.5, if applicable)', required: false },
  { envelope: 'technical', key: 'financial_requirements', label: 'Financial Requirements (Format 7.6)', required: true },
  { envelope: 'technical', key: 'undertaking', label: 'Undertaking (Format 7.7)', required: true },
  { envelope: 'technical', key: 'related_company_disclosure', label: 'Related Company Disclosure (Format 7.8/7.8A)', required: true },
  { envelope: 'technical', key: 'technology_tie_up_declaration', label: 'Technology Tie-Up Declaration (Format 7.9)', required: true },
  { envelope: 'technical', key: 'integrity_pact', label: 'Integrity Pact (Format 7.10)', required: true },
  // §6.1 Corporate & Legal
  { envelope: 'technical', key: 'moa', label: 'Memorandum of Association (MoA)', required: true },
  { envelope: 'technical', key: 'aoa', label: 'Articles of Association (AoA)', required: true },
  { envelope: 'technical', key: 'certificate_of_incorporation', label: 'Certificate of Incorporation', required: true },
  { envelope: 'technical', key: 'shareholding_certificate', label: 'Shareholding Certificate', required: true },
  { envelope: 'technical', key: 'pending_conversion_securities', label: 'Pending-Conversion Securities Details', required: false },
  { envelope: 'technical', key: 'consortium_documents', label: 'Consortium Documents (if applicable)', required: false },
  { envelope: 'technical', key: 'spv_moa_aoa', label: 'SPV MoA/AoA (if applicable)', required: false },
  // §6.1 Financial Qualification
  { envelope: 'technical', key: 'ca_certificate', label: 'CA / Statutory Auditor Certificate', required: true },
  { envelope: 'technical', key: 'audited_accounts', label: 'Audited / Provisional Accounts', required: true },
  { envelope: 'technical', key: 'balance_sheet', label: 'Balance Sheet', required: true },
  { envelope: 'technical', key: 'profit_and_loss', label: 'Profit & Loss Statement', required: true },
  { envelope: 'technical', key: 'schedules', label: 'Schedules', required: true },
  { envelope: 'technical', key: 'cash_flow_statement', label: 'Cash Flow Statement', required: true },
  { envelope: 'technical', key: 'bank_statements', label: 'Bank Statements (where applicable)', required: false },
  // §6.1 Eligibility & Supporting
  { envelope: 'technical', key: 'eligibility_supporting_docs', label: 'Documents Supporting Eligibility Criteria', required: true },
  { envelope: 'technical', key: 'neft_rtgs_bid_purchase_fee', label: 'NEFT/RTGS Proof — Bid Purchase Fee (where required)', required: false },
  { envelope: 'technical', key: 'neft_rtgs_bid_processing_fee', label: 'NEFT/RTGS Proof — Bid Processing Fee (where required)', required: false },
  // §6.2 Financial Bid — Second Envelope
  { envelope: 'financial', key: 'financial_bid_covering_letter', label: 'Financial Bid Covering Letter (Format 7.11)', required: true },
  { envelope: 'financial', key: 'preliminary_cost_estimate', label: 'Preliminary Estimate of Cost of Project (Format 7.12)', required: true },
];

export async function seedDefaultDocumentFields(tenderId: number): Promise<void> {
  await TenderDocumentField.bulkCreate(
    DEFAULT_FIELDS.map((f, index) => ({
      tenderId,
      envelope: f.envelope,
      key: f.key,
      label: f.label,
      required: f.required,
      templateS3Key: null,
      templateOriginalFilename: null,
      sortOrder: index,
    }))
  );
}
