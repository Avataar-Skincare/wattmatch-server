import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from '../db/sequelize.js';
import type { DocumentEnvelope } from './TenderDocumentField.js';

// The platform-wide blank-format PDF for one checklist key (see defaultTenderDocumentFields.ts's
// DEFAULT_FIELDS) — upload it once here and every new tender's TenderDocumentField row for that key
// starts pre-filled with it (seedDefaultDocumentFields), instead of an admin re-uploading the same
// blank format for every tender. A per-tender admin can still replace it for one specific tender via
// the existing POST /tenders/:id/document-fields/:fieldId/template route — that only ever touches
// the tender's own TenderDocumentField row, never this table, so it's a one-off override, not a
// change to the default going forward.
export class DefaultTenderDocumentTemplate extends Model<
  InferAttributes<DefaultTenderDocumentTemplate>,
  InferCreationAttributes<DefaultTenderDocumentTemplate>
> {
  declare id: CreationOptional<number>;
  declare envelope: DocumentEnvelope;
  declare key: string;
  declare templateS3Key: string;
  declare templateOriginalFilename: string;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

DefaultTenderDocumentTemplate.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    envelope: { type: DataTypes.ENUM('technical', 'financial'), allowNull: false },
    key: { type: DataTypes.STRING, allowNull: false, unique: true },
    templateS3Key: { type: DataTypes.STRING, allowNull: false },
    templateOriginalFilename: { type: DataTypes.STRING, allowNull: false },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wattmatch_default_tender_document_templates',
    underscored: true,
  }
);
