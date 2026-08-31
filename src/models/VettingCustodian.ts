import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from '../db/sequelize.js';

// The people who each hold one Shamir share of the technical AND financial custodian keys
// (vettingCrypto.ts) — a small, static, platform-wide roster (normally 3 rows), not per-tender and
// not an Organization. Created only via scripts/create-vetting-custodian.mjs, never a web endpoint —
// same out-of-band-only convention as the key-lifecycle scripts (generate-vetting-keypairs.mjs,
// reshare-vetting-key.mjs) this scheme already relies on. Deliberately kept separate from the
// Organization/org-role auth system (middleware/auth.ts) — a custodian's authority to act comes from
// holding a real key share, not from any Wattmatch admin login, which is the whole point of the
// custodian scheme existing at all (see vettingCrypto.ts's own comment).
export class VettingCustodian extends Model<InferAttributes<VettingCustodian>, InferCreationAttributes<VettingCustodian>> {
  declare id: CreationOptional<number>;
  declare name: string;
  declare email: string;
  declare readonly createdAt: CreationOptional<Date>;
}

VettingCustodian.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.STRING, allowNull: false },
    email: { type: DataTypes.STRING, allowNull: false, unique: true },
    createdAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wattmatch_vetting_custodians',
    underscored: true,
    updatedAt: false,
  }
);
