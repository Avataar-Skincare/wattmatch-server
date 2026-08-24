import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from '../db/sequelize.js';

// 'admin' is WattMatch's own internal ops team — not publicly self-registered (see
// routes/organizations.ts's registerBodySchema, which deliberately only allows 'buyer'/
// 'generator'); created only via scripts/create-admin.mjs. Introduced so admins can create tenders
// with real per-tender pricing (see routes/tenders.ts) using the exact same login/JWT/auth
// machinery already built for buyer/generator orgs, rather than a separate auth system.
export type OrganizationType = 'buyer' | 'generator' | 'admin';

// Minimal registration record — see MINIMAL_PIPELINE_INTEGRATION_PLAN.md. Deliberately not the
// real multi-tenancy model from PLATFORM_ESTIMATE.md (no separate User/team concept yet) — one
// row is treated as one login identity for this integration-proving pass.
export class Organization extends Model<InferAttributes<Organization>, InferCreationAttributes<Organization>> {
  declare id: CreationOptional<number>;
  declare type: OrganizationType;
  declare name: string;
  declare contactEmail: string;
  declare contactPhone: string;
  // Argon2id hash — see lib/passwordAuth.ts and AUTH_STRATEGY_DECISIONS.md. Nullable only because
  // rows created before this field existed have none; every org created through the real
  // registration route now always has one.
  declare passwordHash: string | null;
  declare emailVerified: CreationOptional<boolean>;
  declare emailVerifiedAt: Date | null;
  // Generator-only self-declared capacity, used by the matching engine (tenders.ts) — null for
  // buyers and for generators who haven't set it yet.
  declare capacityMw: string | null;
  declare readonly createdAt: CreationOptional<Date>;
}

Organization.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    type: { type: DataTypes.ENUM('buyer', 'generator', 'admin'), allowNull: false },
    name: { type: DataTypes.STRING, allowNull: false },
    contactEmail: { type: DataTypes.STRING, allowNull: false, unique: true },
    contactPhone: { type: DataTypes.STRING, allowNull: false },
    passwordHash: { type: DataTypes.STRING, allowNull: true },
    emailVerified: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    emailVerifiedAt: { type: DataTypes.DATE, allowNull: true },
    capacityMw: { type: DataTypes.DECIMAL(10, 2), allowNull: true },
    createdAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wattmatch_organizations',
    underscored: true,
    updatedAt: false,
  }
);
