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
  declare readonly createdAt: CreationOptional<Date>;
}

Tender.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    buyerOrgId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    title: { type: DataTypes.STRING, allowNull: false },
    requiredCapacityMw: { type: DataTypes.DECIMAL(10, 2), allowNull: false },
    status: { type: DataTypes.ENUM('open', 'vetting', 'live', 'closed'), allowNull: false, defaultValue: 'open' },
    requirementsDetail: { type: DataTypes.TEXT, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wattmatch_tenders',
    underscored: true,
    updatedAt: false,
  }
);
