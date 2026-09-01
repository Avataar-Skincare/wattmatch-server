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

  // Written once by routes/vettingCustodian.ts's POST /ceremony/complete — the plaintext a custodian
  // ceremony revealed, encrypted via fieldEncryption.ts (KMS-based; a different mechanism from the
  // custodian scheme itself, same distinction VettingDecidedRecord's own comment draws: this is an
  // access-control problem for admin review, not a custodian-consent problem). Deliberately NOT the
  // same as VettingDecidedRecord, which stays "populated only after a decision" — this is the
  // in-between "opened, awaiting admin's decision" state admin reads via GET
  // /vetting-bids/:tenderRef/opened/:envelope to copy into technical-decision's reviewedContent.
  declare technicalOpenedContent: string | null;
  declare financialOpenedContent: string | null;

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

    technicalOpenedContent: { type: DataTypes.TEXT, allowNull: true },
    financialOpenedContent: { type: DataTypes.TEXT, allowNull: true },

    createdAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wattmatch_vetting_bids',
    underscored: true,
    updatedAt: false,
    // Backs the "one sealed bid per generator per tender" invariant at the DB level — previously
    // only an application-level findOne-then-create check in vettingBids.ts, which two
    // near-simultaneous submissions from the same generator could both pass. NULL generatorOrgId
    // (legacy rows submitted before invitation-gated submission existed) is exempt: MySQL treats
    // each NULL as distinct in a unique index, so those aren't affected.
    indexes: [{ unique: true, fields: ['tender_ref', 'generator_org_id'] }],
  }
);
