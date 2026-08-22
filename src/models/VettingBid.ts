import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from '../db/sequelize.js';

export type TechnicalStatus = 'pending' | 'approved' | 'rejected';

// A sealed submission: technical qualification and financial (rate) bid, submitted together in
// one action but sealed under two independent keys (see VETTING_BID_SEALING_IMPLEMENTATION_PLAN.md)
// — opening one envelope never grants any ability to decrypt the other. Every ciphertext/iv/
// wrappedKey field here is opaque; this model never holds plaintext. `tenderRef` is a plain string,
// not a foreign key, since there is no Tender/Listing model yet (MARKETPLACE_PLAN.md territory) —
// vetting happens before a live auction round is even seeded.
export class VettingBid extends Model<InferAttributes<VettingBid>, InferCreationAttributes<VettingBid>> {
  declare id: CreationOptional<number>;
  declare tenderRef: string;
  declare applicantAlias: string;
  // Nullable: rows submitted before invitation-gated submission existed have none. A real
  // submission now always has this set to the authenticated generator's own org id — see
  // tenders.ts/vettingBids.ts's invitation gate.
  declare generatorOrgId: number | null;

  declare technicalWrappedKey: string;
  declare technicalIv: string;
  declare technicalCiphertext: string;
  declare technicalCiphertextHash: string;

  declare financialWrappedKey: string;
  declare financialIv: string;
  declare financialCiphertext: string;
  declare financialCiphertextHash: string;

  // Gates the financial ceremony: only submissions already 'approved' ever have their financial
  // envelope decrypted — a rejected generator's financial envelope is never decrypted, full stop.
  declare technicalStatus: CreationOptional<TechnicalStatus>;

  declare readonly createdAt: CreationOptional<Date>;
}

VettingBid.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    tenderRef: { type: DataTypes.STRING, allowNull: false },
    applicantAlias: { type: DataTypes.STRING, allowNull: false },
    generatorOrgId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },

    technicalWrappedKey: { type: DataTypes.TEXT, allowNull: false },
    technicalIv: { type: DataTypes.STRING, allowNull: false },
    technicalCiphertext: { type: DataTypes.TEXT, allowNull: false },
    technicalCiphertextHash: { type: DataTypes.STRING, allowNull: false },

    financialWrappedKey: { type: DataTypes.TEXT, allowNull: false },
    financialIv: { type: DataTypes.STRING, allowNull: false },
    financialCiphertext: { type: DataTypes.TEXT, allowNull: false },
    financialCiphertextHash: { type: DataTypes.STRING, allowNull: false },

    technicalStatus: { type: DataTypes.ENUM('pending', 'approved', 'rejected'), allowNull: false, defaultValue: 'pending' },

    createdAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wattmatch_vetting_bids',
    underscored: true,
    updatedAt: false,
  }
);
