import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from '../db/sequelize.js';
import type { VettingEnvelope } from './VettingOpeningAttestation.js';

// One row per (custodian, tender, envelope) ceremony instance — the credential behind a custodian's
// unique-per-tender ceremony link, emailed when routes/tenders.ts's scheduled technicalBidOpenAt/
// financialBidOpenAt arrives. Same shape and reasoning as OrganizationToken (opaque, hashed at rest —
// see lib/passwordAuth.ts's generateOpaqueToken/hashOpaqueToken, reused directly here rather than a
// new token scheme), just scoped to a VettingCustodian instead of an Organization. Unlike
// OrganizationToken's single-use purposes, usedAt here only marks first use for audit — the token
// itself stays valid for repeated GETs (checking ceremony status) until expiry; what actually
// prevents a double share submission is the ceremony state itself (routes/vettingCustodian.ts checks
// whether this custodian already has a recorded submission), not token consumption.
export class VettingCustodianToken extends Model<InferAttributes<VettingCustodianToken>, InferCreationAttributes<VettingCustodianToken>> {
  declare id: CreationOptional<number>;
  declare custodianId: number;
  declare tenderId: number;
  declare envelope: VettingEnvelope;
  declare tokenHash: string;
  declare expiresAt: Date;
  declare usedAt: Date | null;
  declare readonly createdAt: CreationOptional<Date>;
}

VettingCustodianToken.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    custodianId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    tenderId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    envelope: { type: DataTypes.ENUM('technical', 'financial'), allowNull: false },
    tokenHash: { type: DataTypes.STRING, allowNull: false, unique: true },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    usedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wattmatch_vetting_custodian_tokens',
    underscored: true,
    updatedAt: false,
  }
);
