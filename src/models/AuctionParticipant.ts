import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from '../db/sequelize.js';

export type AuctionParticipantRole = 'generator' | 'buyer';

// PoC scope: real identity fields are plaintext (organizationName), not KMS-encrypted — see
// AUCTION_MVP_PLAN.md's "deliberately out of scope" list. Do not carry this table's shape forward
// unencrypted once real generator identity is involved.
export class AuctionParticipant extends Model<InferAttributes<AuctionParticipant>, InferCreationAttributes<AuctionParticipant>> {
  declare id: CreationOptional<number>;
  declare auctionId: number;
  // Encrypted at rest via fieldEncryption.ts (see LIVE_AUCTION_IDENTITY_ENCRYPTION_PLAN.md) — never
  // the plaintext organization name. Callers must encryptField() before create()/update() and
  // decryptField() after any read that legitimately needs the real name; nothing in this file does
  // either automatically, so a plaintext value can't accidentally slip in through a code path that
  // forgot to encrypt it.
  declare organizationName: string;
  declare alias: string;
  // 'buyer' is a read-only spectator seat — same alias-only exposure and join-token mechanism as a
  // generator, just never allowed to submit a bid (enforced server-side in auctionSocket.ts, not
  // just hidden client-side). Defaults to 'generator' so every pre-existing row stays valid.
  declare role: CreationOptional<AuctionParticipantRole>;
  // Unique per generator, not single-use — stays valid for the auction's duration so a dropped
  // participant can reconnect with the same link. Embedded as the JWT's `jti` claim.
  declare joinTokenId: string;
  // Set once this participant explicitly acknowledges the auction rules (incl. the non-binding
  // disclosure) — bidding is gated on this being non-null, not just shown as a UI formality.
  declare rulesAcceptedAt: Date | null;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

AuctionParticipant.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    auctionId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    organizationName: { type: DataTypes.TEXT, allowNull: false },
    alias: { type: DataTypes.STRING, allowNull: false },
    role: { type: DataTypes.ENUM('generator', 'buyer'), allowNull: false, defaultValue: 'generator' },
    joinTokenId: { type: DataTypes.STRING, allowNull: false, unique: true },
    rulesAcceptedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wattmatch_auction_participants',
    underscored: true,
  }
);
