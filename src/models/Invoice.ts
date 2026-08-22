import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from '../db/sequelize.js';

// One row per Payment that has ever transitioned to 'paid' — see services/invoiceService.ts and
// Red Flag #6 in TENDER_WORKFLOW_STAKEHOLDER_PLAN.md ("every fee charged is a taxable sale...
// auto-generate a proper GST invoice the moment any fee is paid"). `sellerGstin` is nullable
// because Wattmatch does not yet hold a GSTIN (see PricingPage.tsx's own note) — a null value here
// means the generated PDF is a provisional receipt, not a real tax invoice; this column is what
// lets a later audit tell which documents were issued before vs. after GST registration.
export class Invoice extends Model<InferAttributes<Invoice>, InferCreationAttributes<Invoice>> {
  declare id: CreationOptional<number>;
  declare paymentId: number;
  declare invoiceNumber: string;
  declare issuedAt: Date;
  declare sellerName: string;
  declare sellerGstin: string | null;
  declare buyerName: string | null;
  declare buyerEmail: string | null;
  declare amountPaise: number;
  declare currency: string;
  declare s3Key: string;
  declare readonly createdAt: CreationOptional<Date>;
}

Invoice.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    paymentId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, unique: true },
    invoiceNumber: { type: DataTypes.STRING, allowNull: false, unique: true },
    issuedAt: { type: DataTypes.DATE, allowNull: false },
    sellerName: { type: DataTypes.STRING, allowNull: false },
    sellerGstin: { type: DataTypes.STRING, allowNull: true },
    buyerName: { type: DataTypes.STRING, allowNull: true },
    buyerEmail: { type: DataTypes.STRING, allowNull: true },
    amountPaise: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    currency: { type: DataTypes.STRING, allowNull: false },
    s3Key: { type: DataTypes.STRING, allowNull: false },
    createdAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wattmatch_invoices',
    underscored: true,
    updatedAt: false,
  }
);
