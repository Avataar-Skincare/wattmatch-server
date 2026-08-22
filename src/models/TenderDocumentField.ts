import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from '../db/sequelize.js';

export type DocumentEnvelope = 'technical' | 'financial';

// Stage 6.3's "form-field registry keyed per tender, not a fixed schema" — every document
// requirement (Covering Letter, MoA, Board Resolutions, ...) is one row here. Seeded with the
// plan's default checklist at tender creation (see defaultTenderDocumentFields.ts); an admin can
// then add/delete fields per tender on top of that default set.
export class TenderDocumentField extends Model<InferAttributes<TenderDocumentField>, InferCreationAttributes<TenderDocumentField>> {
  declare id: CreationOptional<number>;
  declare tenderId: number;
  declare envelope: DocumentEnvelope;
  // Stable identifier (e.g. "moa", "board_resolutions") — never shown to a user, just a durable key
  // an upload attaches to so relabeling a field later doesn't orphan existing uploads.
  declare key: string;
  declare label: string;
  declare required: CreationOptional<boolean>;
  // "View format" half of the paired control — null means no blank template has been attached yet,
  // not that none is needed.
  declare templateS3Key: string | null;
  declare templateOriginalFilename: string | null;
  declare sortOrder: CreationOptional<number>;
  declare readonly createdAt: CreationOptional<Date>;
}

TenderDocumentField.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    tenderId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    envelope: { type: DataTypes.ENUM('technical', 'financial'), allowNull: false },
    key: { type: DataTypes.STRING, allowNull: false },
    label: { type: DataTypes.STRING, allowNull: false },
    required: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    templateS3Key: { type: DataTypes.STRING, allowNull: true },
    templateOriginalFilename: { type: DataTypes.STRING, allowNull: true },
    sortOrder: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    createdAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wattmatch_tender_document_fields',
    underscored: true,
    updatedAt: false,
  }
);
