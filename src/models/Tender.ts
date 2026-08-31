import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from '../db/sequelize.js';

export type TenderStatus = 'open' | 'vetting' | 'live' | 'closed';

// Minimal tender requirement record — see MINIMAL_PIPELINE_INTEGRATION_PLAN.md. Deliberately
// small: no deal-structure fields (Open Access / Group Captive / Rooftop) since that classification
// is still an open founder/legal decision (PLATFORM_ESTIMATE.md's biggest flagged risk) — adding
// those fields now would be guessing at a decision this minimal pass explicitly avoids needing.
export class Tender extends Model<InferAttributes<Tender>, InferCreationAttributes<Tender>> {
  declare id: CreationOptional<number>;
  declare buyerOrgId: number;
  declare title: string;
  declare requiredCapacityMw: string;
  declare status: CreationOptional<TenderStatus>;
  // Full requirement detail — deliberately separate from the teaser fields (title, capacity) any
  // matched-but-not-yet-invited generator can see via /tenders/:id/matches. Only ever returned by
  // GET /tenders/:id, which gates on the caller being the owning buyer or an invited generator.
  declare requirementsDetail: string | null;
  // Per-tender pricing (TENDER_WORKFLOW_STAKEHOLDER_PLAN.md's fee sections describe rates
  // varying by tender/capacity) — set deliberately by the admin who creates the tender (see
  // routes/tenders.ts's admin-only POST /tenders), not a platform-wide flat fee. A DB-level
  // default matching the old pricingService.ts stub (₹1) exists ONLY so rows created directly by
  // tests/scripts without specifying these don't break — the real admin-creation route always
  // requires explicit values and never relies on this default.
  declare rfsDocumentFeePaise: CreationOptional<number>;
  declare bidProcessingFeePaise: CreationOptional<number>;
  // Disclosed EMD requirement — no longer a Payment amount (EMD is a Bank Guarantee document, see
  // EmdSubmission), just how large a BG a generator needs to arrange for this tender.
  declare emdAmountPaise: CreationOptional<number>;
  // Two admin-uploaded PDFs, distinct in visibility: the RfS document is free to download the
  // moment the tender is public (TenderDetailsPage), the tender document is gated behind the RfS
  // Document / Bid Purchase fee (see hasRfsDocumentPaid) — both nullable since a tender can exist
  // before either is uploaded.
  declare rfsDocumentS3Key: string | null;
  declare rfsDocumentOriginalFilename: string | null;
  declare tenderDocumentS3Key: string | null;
  declare tenderDocumentOriginalFilename: string | null;
  // Ceremony scheduling — set once, deliberately, at admin creation (see routes/tenders.ts's
  // postTenderBodySchema, which requires all three in strict order). Nullable only because rows
  // created before this existed (tests, old data) have none — the real creation route never relies
  // on that. bidSubmissionDeadline gates POST /vetting-bids; technicalBidOpenAt/financialBidOpenAt
  // gate routes/vettingCustodian.ts's share submission and drive when custodian invite emails fire.
  declare bidSubmissionDeadline: Date | null;
  declare technicalBidOpenAt: Date | null;
  declare financialBidOpenAt: Date | null;
  // Landed-rate auction inputs — set once, deliberately, at admin creation (see
  // routes/tenders.ts's postTenderBodySchema), copied onto the Auction row this tender eventually
  // promotes to (see vettingAuctionBridge.ts) rather than read live from here during bidding.
  // Nullable only for rows created before this existed.
  declare equityValue: string | null;
  declare totalUnitsPerYear: string | null;
  // Per-tender switch, decided at creation: landed-rate auction (equityValue/totalUnitsPerYear
  // required, see postTenderBodySchema) vs a normal-rate auction (today's original behavior — a
  // single rate, lowest wins, no returns% involved). Defaults false so every tender created before
  // this existed stays a normal-rate auction, not silently opted into the new formula.
  declare useLandedRate: CreationOptional<boolean>;
  declare readonly createdAt: CreationOptional<Date>;
}

const PRICING_STUB_DEFAULT_PAISE = 100; // ₹1 — same placeholder pricingService.ts used before this existed

Tender.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    buyerOrgId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    title: { type: DataTypes.STRING, allowNull: false },
    requiredCapacityMw: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    status: { type: DataTypes.ENUM('open', 'vetting', 'live', 'closed'), allowNull: false, defaultValue: 'open' },
    requirementsDetail: { type: DataTypes.TEXT, allowNull: true },
    rfsDocumentFeePaise: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: PRICING_STUB_DEFAULT_PAISE },
    bidProcessingFeePaise: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: PRICING_STUB_DEFAULT_PAISE },
    emdAmountPaise: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: PRICING_STUB_DEFAULT_PAISE },
    rfsDocumentS3Key: { type: DataTypes.STRING, allowNull: true },
    rfsDocumentOriginalFilename: { type: DataTypes.STRING, allowNull: true },
    tenderDocumentS3Key: { type: DataTypes.STRING, allowNull: true },
    tenderDocumentOriginalFilename: { type: DataTypes.STRING, allowNull: true },
    bidSubmissionDeadline: { type: DataTypes.DATE, allowNull: true },
    technicalBidOpenAt: { type: DataTypes.DATE, allowNull: true },
    financialBidOpenAt: { type: DataTypes.DATE, allowNull: true },
    equityValue: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    totalUnitsPerYear: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    useLandedRate: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    createdAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wattmatch_tenders',
    underscored: true,
    updatedAt: false,
  }
);
