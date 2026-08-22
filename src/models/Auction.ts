import { DataTypes, Model, type CreationOptional, type InferAttributes, type InferCreationAttributes } from 'sequelize';
import { sequelize } from '../db/sequelize.js';

export type AuctionStatus = 'scheduled' | 'live' | 'closed';

export class Auction extends Model<InferAttributes<Auction>, InferCreationAttributes<Auction>> {
  declare id: CreationOptional<number>;
  declare title: string;
  declare status: AuctionStatus;
  // Opening bid = lowest bid submitted during enrollment (see AUCTION_MVP_PLAN.md) — every
  // participant starts the live round level, at this same number.
  declare openingBid: string;
  // Display/reporting mirror only — Redis, not this column, decides bid acceptance.
  declare currentLowestBid: string | null;
  // Mirrors of Redis's leaderParticipantId/leaderAlias, written on every accepted bid — restart
  // resilience: if Redis state is ever lost mid-auction (restart without persistence, eviction),
  // these are what let the auction be reconstructed with the correct current leader instead of
  // silently resuming with nobody leading, which would let it close with no winner despite one
  // having actually existed. See auctionEngine.ts's reconstructAuctionState.
  declare currentLeaderParticipantId: number | null;
  declare currentLeaderAlias: string | null;
  declare windowSeconds: number;
  declare maxAutoExtensions: number;
  // Rule-version tracking: snapshots the platform-wide MIN_UNDERCUT constant (auctionEngine.ts) at
  // the moment this auction was created — not a caller-configurable field (it's still a flat
  // platform rule, per AUCTION_PLAN.md). Exists so that if the constant is ever changed later, a
  // past auction's audit record stays accurate to whatever actually applied when *it* ran, instead
  // of being silently reinterpreted under a new value.
  declare minUndercut: string;
  declare currentExtensionCount: CreationOptional<number>;
  declare windowEndsAt: Date | null;
  declare winnerParticipantId: number | null;
  // Written once, at close — a JSON snapshot of the full record (rules, bid chronology, winner)
  // plus its own SHA-256 hash, so the result can be handed to a customer/auditor as one verifiable
  // package. Not a real PKI signature — see AUCTION_MVP_PLAN.md for what's deferred.
  declare resultSummaryJson: string | null;
  declare resultHash: string | null;
  // Populated only when this auction was created via the vetting->auction bridge
  // (VETTING_TO_AUCTION_BRIDGE_PLAN.md) — null for every manually-seeded auction, including all
  // of today's demo auctions. Used for traceability and to guard against promoting the same
  // tender to a live auction twice.
  declare tenderRef: CreationOptional<number | null>;
  declare readonly createdAt: CreationOptional<Date>;
  declare readonly updatedAt: CreationOptional<Date>;
}

Auction.init(
  {
    id: { type: DataTypes.INTEGER.UNSIGNED, autoIncrement: true, primaryKey: true },
    title: { type: DataTypes.STRING, allowNull: false },
    status: { type: DataTypes.ENUM('scheduled', 'live', 'closed'), allowNull: false, defaultValue: 'scheduled' },
    openingBid: { type: DataTypes.DECIMAL(10, 4), allowNull: false },
    currentLowestBid: { type: DataTypes.DECIMAL(10, 4), allowNull: true },
    currentLeaderParticipantId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    currentLeaderAlias: { type: DataTypes.STRING, allowNull: true },
    windowSeconds: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 480 },
    maxAutoExtensions: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 8 },
    minUndercut: { type: DataTypes.DECIMAL(10, 4), allowNull: false, defaultValue: 0.01 },
    currentExtensionCount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    windowEndsAt: { type: DataTypes.DATE, allowNull: true },
    winnerParticipantId: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    resultSummaryJson: { type: DataTypes.TEXT, allowNull: true },
    resultHash: { type: DataTypes.STRING, allowNull: true },
    tenderRef: { type: DataTypes.INTEGER.UNSIGNED, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wattmatch_auctions',
    underscored: true,
  }
);
