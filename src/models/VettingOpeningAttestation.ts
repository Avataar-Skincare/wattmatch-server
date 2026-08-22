import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from '../db/sequelize.js';

export type VettingEnvelope = 'technical' | 'financial';

// One row per ceremony — proves *that* two custodians participated in opening a given envelope for
// a tender, without ever storing key material or the third, absent custodian's identity. See
// VETTING_BID_SEALING_IMPLEMENTATION_PLAN.md's "Two confirmed design decisions" section for the
// emergency-fast-open fields.
export class VettingOpeningAttestation extends Model<
  InferAttributes<VettingOpeningAttestation>,
  InferCreationAttributes<VettingOpeningAttestation>
> {
  declare id: CreationOptional<number>;
  declare tenderRef: string;
  declare envelope: VettingEnvelope;
  // Hash of the set of bid ids + ciphertext hashes opened in this ceremony — lets anyone later
  // verify exactly which submissions this attestation covers.
  declare openedSetHash: string;
  // SHA-256 fingerprints of the two shares actually used — never the shares themselves.
  declare shareFingerprint1: string;
  declare shareFingerprint2: string;
  // True only for the emergency fast-open path (a suspected, not-yet-confirmed compromise) —
  // distinguishes it from a routine scheduled opening in the audit trail.
  declare isEmergency: CreationOptional<boolean>;
  declare emergencyJustification: string | null;
  declare readonly createdAt: CreationOptional<Date>;
}

VettingOpeningAttestation.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    tenderRef: { type: DataTypes.STRING, allowNull: false },
    envelope: { type: DataTypes.ENUM('technical', 'financial'), allowNull: false },
    openedSetHash: { type: DataTypes.STRING, allowNull: false },
    shareFingerprint1: { type: DataTypes.STRING, allowNull: false },
    shareFingerprint2: { type: DataTypes.STRING, allowNull: false },
    isEmergency: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    emergencyJustification: { type: DataTypes.TEXT, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wattmatch_vetting_opening_attestations',
    underscored: true,
    updatedAt: false,
  }
);
