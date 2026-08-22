import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from '../db/sequelize.js';

// A generator's filled-in PDF for one TenderDocumentField — the "Upload" half of Stage 6.3's
// paired control. Stored via lib/s3.ts (SSE-KMS + short-lived signed URLs, per the plan's storage
// spec), NOT through the sealed-bid client-side encryption scheme reserved for the technical/
// financial bid CONTENT itself (capacity, tariff) — these are supporting compliance documents, a
// different and lower-ceremony threat model, matching how the plan's own Tech Stack section scopes
// document storage separately from the custodian ceremony.
export class TenderDocumentUpload extends Model<InferAttributes<TenderDocumentUpload>, InferCreationAttributes<TenderDocumentUpload>> {
  declare id: CreationOptional<number>;
  declare tenderId: number;
  declare organizationId: number;
  declare fieldId: number;
  declare s3Key: string;
  declare originalFilename: string;
  declare sizeBytes: number;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

TenderDocumentUpload.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    tenderId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    organizationId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    fieldId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    s3Key: { type: DataTypes.STRING, allowNull: false },
    originalFilename: { type: DataTypes.STRING, allowNull: false },
    sizeBytes: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wattmatch_tender_document_uploads',
    underscored: true,
    indexes: [{ unique: true, fields: ['field_id', 'organization_id'] }],
  }
);
