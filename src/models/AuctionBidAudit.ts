import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { auditSequelize } from '../db/auditSequelize.js';

// Same table as AuctionBid, but bound to the restricted audit-writer DB connection (SELECT+INSERT
// only — see .env.example and auditSequelize.ts). This is the ONLY model that should ever write to
// wattmatch_auction_bids; appendAuditedBid() in auctionEngine.ts uses this exclusively, not the
// AuctionBid model (which stays on the main, full-access connection, used for reads elsewhere).
// Deliberately duplicates AuctionBid's column definitions — Sequelize models bind to one
// connection each, so this can't just reuse that class. Keep both in sync if the schema changes.
export class AuctionBidAudit extends Model<InferAttributes<AuctionBidAudit>, InferCreationAttributes<AuctionBidAudit>> {
  declare id: CreationOptional<number>;
  declare auctionId: number;
  declare participantId: number;
  declare alias: string;
  declare amount: string;
  declare rate: string | null;
  declare returnPercent: string | null;
  declare accepted: boolean;
  declare rejectReason: string | null;
  declare ipHash: string | null;
  // Empty string ('', not null) for the very first bid row of a given auction — see AuctionBid's
  // own comment on why this can't be nullable: the unique (auction_id, prev_hash) index that
  // prevents chain-forking needs a real, comparable value to catch two concurrent first bids.
  declare prevHash: string;
  declare hash: string;
  declare readonly createdAt: CreationOptional<Date>;
}

AuctionBidAudit.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    auctionId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    participantId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    alias: { type: DataTypes.STRING, allowNull: false },
    amount: { type: DataTypes.DECIMAL(10, 4), allowNull: false },
    rate: { type: DataTypes.DECIMAL(10, 4), allowNull: true },
    returnPercent: { type: DataTypes.DECIMAL(5, 2), allowNull: true },
    accepted: { type: DataTypes.BOOLEAN, allowNull: false },
    rejectReason: { type: DataTypes.STRING, allowNull: true },
    ipHash: { type: DataTypes.STRING, allowNull: true },
    prevHash: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
    hash: { type: DataTypes.STRING, allowNull: false },
    createdAt: DataTypes.DATE,
  },
  {
    sequelize: auditSequelize,
    tableName: 'wattmatch_auction_bids',
    underscored: true,
    updatedAt: false,
  }
);
