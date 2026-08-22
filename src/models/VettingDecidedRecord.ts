import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from '../db/sequelize.js';
import type { VettingEnvelope } from './VettingOpeningAttestation.js';

// Post-decision durable storage — see VETTING_BID_SEALING_IMPLEMENTATION_PLAN.md's "Post-decision
// durable storage" section. Populated ONLY after a technical-decision has been recorded for a
// submission — never before. Content is re-encrypted via fieldEncryption.ts (the same KMS-based
// module already built for the live auction's participant identity), a deliberately different
// mechanism from the custodian scheme: the custodian scheme's job is controlling WHEN and BY WHOM
// the first reveal happens; this is an access-control problem for already-settled history, not a
// custodian-consent problem. A rejected submission's FINANCIAL content is never written here —
// that envelope is never decrypted by the system at all, regardless of how much time passes.
export class VettingDecidedRecord extends Model<
  InferAttributes<VettingDecidedRecord>,
  InferCreationAttributes<VettingDecidedRecord>
> {
  declare id: CreationOptional<number>;
  declare vettingBidId: number;
  declare envelope: VettingEnvelope;
  // Encrypted via fieldEncryption.ts — never plaintext at rest, but decryptable by an authorized,
  // logged request without needing to reconvene the original custodians.
  declare encryptedContent: string;
  declare decidedAt: Date;
  // Not enforced by this build if left null — the actual retention period is a legal decision, not
  // an engineering default (see the plan's own note) — but the column exists from day one so it
  // isn't a schema migration later once that decision lands.
  declare retentionPurgeAfter: Date | null;
  declare readonly createdAt: CreationOptional<Date>;
}

VettingDecidedRecord.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    vettingBidId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    envelope: { type: DataTypes.ENUM('technical', 'financial'), allowNull: false },
    encryptedContent: { type: DataTypes.TEXT, allowNull: false },
    decidedAt: { type: DataTypes.DATE, allowNull: false },
    retentionPurgeAfter: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wattmatch_vetting_decided_records',
    underscored: true,
    updatedAt: false,
  }
);
