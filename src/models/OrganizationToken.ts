import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from '../db/sequelize.js';

export type OrganizationTokenPurpose = 'email_verification' | 'password_reset';

// One-time, expiring, single-use tokens for the two flows AUTH_STRATEGY_DECISIONS.md calls out as
// needing fresh building, both requiring the same shape (opaque token, hashed at rest, expiring,
// single-use) — kept as one table rather than two near-identical ones. Only tokenHash is ever
// stored; see lib/passwordAuth.ts's generateOpaqueToken for why.
export class OrganizationToken extends Model<InferAttributes<OrganizationToken>, InferCreationAttributes<OrganizationToken>> {
  declare id: CreationOptional<number>;
  declare organizationId: number;
  declare purpose: OrganizationTokenPurpose;
  declare tokenHash: string;
  declare expiresAt: Date;
  declare usedAt: Date | null;
  declare readonly createdAt: CreationOptional<Date>;
}

OrganizationToken.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    organizationId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    purpose: { type: DataTypes.ENUM('email_verification', 'password_reset'), allowNull: false },
    tokenHash: { type: DataTypes.STRING, allowNull: false, unique: true },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    usedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wattmatch_organization_tokens',
    underscored: true,
    updatedAt: false,
  }
);
