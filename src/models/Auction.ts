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
  // Landed-rate formula inputs (see auctionEngine.ts's computeLandedRate) — copied in at seed time
  // from the promoting Tender's own equityValue/totalUnitsPerYear, or supplied directly by an
  // admin seeding a standalone demo auction (auctionAdmin.ts) — same "copy onto Auction, don't
  // live-read Tender" pattern already used for openingBid/windowSeconds/maxAutoExtensions. Nullable
  // only for auctions seeded before this existed.
  declare equityValue: string | null;
  declare totalUnitsPerYear: string | null;
  // Per-auction switch, copied from the promoting Tender's own useLandedRate (or supplied directly
  // for a standalone demo seed) — decides whether submitBid computes a landed rate at all (see
  // auctionEngine.ts). Defaults false so an auction seeded before this existed behaves exactly as
  // it always did.
  declare useLandedRate: CreationOptional<boolean>;
  // Set only for auctions created via the vetting->auction bridge's scheduled promotion
  // (vettingAuctionBridge.ts) — null for every manually-seeded (auctionAdmin.ts) auction, which goes
  // live immediately with no scheduling involved. Exists so a self-healing check
  // (auctionEngine.ts's startScheduledAuctionActivationLoop) can find and activate any auction whose
  // in-process start timer was lost to a server restart between promotion and its start time,
  // instead of relying solely on that one-shot in-memory timer.
  declare scheduledStartAt: Date | null;
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
    equityValue: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    totalUnitsPerYear: { type: DataTypes.DECIMAL(14, 2), allowNull: true },
    useLandedRate: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    scheduledStartAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: 'wattmatch_auctions',
    underscored: true,
    // Backs "a tender can only ever be promoted to a live auction once" at the DB level — previously
    // only an application-level findOne-before-create check in vettingAuctionBridge.ts, which two
    // concurrent promote-to-auction calls could both pass, creating two live auctions for the same
    // tender. NULL tenderRef (every manually-seeded demo auction, auctionAdmin.ts) is exempt: MySQL
    // treats each NULL as distinct in a unique index.
    indexes: [{ unique: true, fields: ['tender_ref'] }],
  }
);
