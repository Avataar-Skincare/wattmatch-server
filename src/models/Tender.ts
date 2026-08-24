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
  declare emdAmountPaise: CreationOptional<number>;
  declare successChargePaise: CreationOptional<number>;
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
    successChargePaise: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: PRICING_STUB_DEFAULT_PAISE },
    createdAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wattmatch_tenders',
    underscored: true,
    updatedAt: false,
  }
);
