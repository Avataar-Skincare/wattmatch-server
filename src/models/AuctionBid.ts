import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from '../db/sequelize.js';

// Append-only — every bid attempt is logged, accepted or not, per AUCTION_PLAN.md's data model.
// A rejected-bid pattern is itself useful audit signal, not just noise to discard.
export class AuctionBid extends Model<InferAttributes<AuctionBid>, InferCreationAttributes<AuctionBid>> {
  declare id: CreationOptional<number>;
  declare auctionId: number;
  declare participantId: number;
  declare alias: string;
  declare amount: string;
  declare accepted: boolean;
  declare rejectReason: string | null;
  declare ipHash: string | null;
  // Tamper-evidence chain (AUCTION_PLAN.md standard): hash = SHA-256(prevHash + this row's
  // content). Empty string ('', not null) for the very first bid row of a given auction —
  // deliberately not nullable, so the unique (auction_id, prev_hash) index can actually catch two
  // concurrent "first bid" attempts racing each other (most SQL engines treat every NULL as
  // distinct from every other NULL in a unique index, so a nullable column wouldn't catch that
  // specific race at all). Written by appendAuditedBid() in auctionEngine.ts — never set directly
  // via AuctionBid.create() elsewhere, or the chain breaks.
  declare prevHash: string;
  declare hash: string;
  declare readonly createdAt: CreationOptional<Date>;
}

AuctionBid.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    auctionId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    participantId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    alias: { type: DataTypes.STRING, allowNull: false },
    amount: { type: DataTypes.DECIMAL(10, 4), allowNull: false },
    accepted: { type: DataTypes.BOOLEAN, allowNull: false },
    rejectReason: { type: DataTypes.STRING, allowNull: true },
    ipHash: { type: DataTypes.STRING, allowNull: true },
    prevHash: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
    hash: { type: DataTypes.STRING, allowNull: false },
    createdAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wattmatch_auction_bids',
    underscored: true,
    updatedAt: false,
  }
);
