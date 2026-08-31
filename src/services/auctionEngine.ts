import crypto from 'node:crypto';
import { Op, UniqueConstraintError } from 'sequelize';
import { redis } from '../lib/redis.js';
import { AuctionBid } from '../models/AuctionBid.js';
import { AuctionBidAudit } from '../models/AuctionBidAudit.js';
import { Auction } from '../models/Auction.js';
import { appendToLocalAuditLog } from '../lib/localAuditLog.js';
import { DEPLOYED_CODE_VERSION } from '../lib/version.js';
import { logger } from '../lib/logger.js';

// Founder-confirmed rule (AUCTION_PLAN.md): no fixed step, just at least 1 paisa below the
// current lowest bid. This is a flat platform rule, not per-auction configurable.
export const MIN_UNDERCUT = 0.01;

// Sanity bounds on a bid amount — the Lua script only checks a bid is below the current lowest,
// with no floor, so a negative or absurd amount would otherwise be silently ACCEPTED as a valid
// leading bid. The upper bound also keeps amounts within what the AuctionBid/AuctionBidAudit
// DECIMAL(10,4) column can actually store — an out-of-range value would otherwise throw on the DB
// insert well after Redis has already been updated with it (see appendAuditedBid).
export const MAX_BID_AMOUNT = 999999;

// For logging a REJECTED bid attempt whose amount is itself invalid (non-finite, negative, or
// too large) — the raw value can't just be passed to appendAuditedBid as-is, since an
// out-of-range amount would overflow the exact same DECIMAL(10,4) column the rejection is trying
// to record, turning a clean "rejected: invalid amount" into an unhandled DB error instead.
// Clamping preserves some signal (how far out of range the attempt was) without risking that.
export function sanitizeAmountForAudit(amount: number): string {
  if (!Number.isFinite(amount)) return '0';
  return String(Math.max(-MAX_BID_AMOUNT, Math.min(MAX_BID_AMOUNT, amount)));
}

// Same reasoning as sanitizeAmountForAudit above, clamped to returnPercent's own valid range
// (0–100) instead of MAX_BID_AMOUNT — a rejected attempt with an out-of-range percent still needs
// to be recorded without overflowing the DECIMAL(5,2) column it's stored in.
export function sanitizePercentForAudit(percent: number): string {
  if (!Number.isFinite(percent)) return '0';
  return String(Math.max(0, Math.min(100, percent)));
}

// Landed-rate formula (product decision, not derived from anything in this codebase): a generator's
// raw rate is discounted by their offered return% scaled against the tender/auction's equity value
// and normalized by its total annual units — this discounted number, not the raw rate, is what
// actually competes in the live auction (see submitBid below). Deliberately allowed to go negative
// (a high enough return% can push it below zero) — flooring it at 0 would silently distort the
// ranking this formula exists to produce.
export function computeLandedRate(rate: number, returnPercent: number, equityValue: number, totalUnitsPerYear: number): number {
  return rate - ((returnPercent / 100) * equityValue) / totalUnitsPerYear;
}

// Fixed platform-wide disclosure, not a per-auction toggle — see REGULATORY_CERTIFICATION_RESEARCH.md's
// "Recommended regulatory position": keeping the auction output non-binding is the lowest-risk
// structure for the CERC classification question. Deliberately not configurable per auction so
// nobody can flip it to "binding" without a real legal review first.
export const RESULT_TYPE = 'non_binding_match' as const;
export const RESULT_DISCLOSURE =
  'This result is an indicative, non-binding match. The PPA is negotiated and executed separately between the buyer and the winning generator.';

function auctionKey(auctionId: number) {
  return `auction:${auctionId}`;
}

// Lua return values are wrapped with tostring() everywhere a price/timestamp crosses the
// Redis boundary — Redis converts a bare Lua number to a RESP integer, silently truncating
// decimals, which would corrupt a tariff like 6.53 into 6. Returning strings avoids that.
const SUBMIT_BID_LUA = `
local key = KEYS[1]
local newBid = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local participantId = ARGV[3]
local alias = ARGV[4]
local minUndercut = tonumber(redis.call('HGET', key, 'minUndercut'))

local status = redis.call('HGET', key, 'status')
if status ~= 'live' then
  return {'REJECTED', 'AUCTION_NOT_LIVE', redis.call('HGET', key, 'currentBid')}
end

local currentBid = tonumber(redis.call('HGET', key, 'currentBid'))
if newBid > (currentBid - minUndercut) then
  return {'REJECTED', 'NOT_LOW_ENOUGH', tostring(currentBid)}
end

local windowMs = tonumber(redis.call('HGET', key, 'windowMs'))
local extCount = tonumber(redis.call('HGET', key, 'extensionCount'))
local maxExt = tonumber(redis.call('HGET', key, 'maxExtensions'))

local newWindowEndsAt
if extCount < maxExt then
  newWindowEndsAt = now + windowMs
  redis.call('HSET', key, 'extensionCount', extCount + 1)
else
  newWindowEndsAt = tonumber(redis.call('HGET', key, 'windowEndsAt'))
end

redis.call('HSET', key,
  'currentBid', tostring(newBid),
  'windowEndsAt', tostring(newWindowEndsAt),
  'leaderParticipantId', participantId,
  'leaderAlias', alias)
return {'ACCEPTED', tostring(newBid), tostring(newWindowEndsAt)}
`;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    submitBid(
      key: string,
      newBid: string,
      now: string,
      participantId: string,
      alias: string
    ): Promise<[status: 'ACCEPTED' | 'REJECTED', valueOrReason: string, extra: string]>;
  }
}

redis.defineCommand('submitBid', { numberOfKeys: 1, lua: SUBMIT_BID_LUA });

export interface AuctionRedisState {
  status: 'scheduled' | 'live' | 'closed';
  currentBid: number;
  windowEndsAt: number | null;
  windowMs: number;
  extensionCount: number;
  maxExtensions: number;
  minUndercut: number;
  leaderParticipantId: number | null;
  leaderAlias: string | null;
  // Constant for the lifetime of the auction, written once here and never updated afterward — safe
  // for submitBid to read non-atomically alongside the Lua compare-and-set below. Forwarded to the
  // frontend as-is via state:sync so a bidder's own landed-rate preview matches what the server will
  // actually compute.
  equityValue: number;
  totalUnitsPerYear: number;
  // Per-auction switch — see Auction.useLandedRate's own comment. When false, submitBid never
  // calls computeLandedRate at all, regardless of what equityValue/totalUnitsPerYear happen to be.
  useLandedRate: boolean;
}

export async function initAuctionState(
  auctionId: number,
  openingBid: number,
  windowSeconds: number,
  maxAutoExtensions: number,
  minUndercut: number,
  useLandedRate: boolean,
  equityValue: number = 0,
  totalUnitsPerYear: number = 0
) {
  await redis.hset(auctionKey(auctionId), {
    status: 'scheduled',
    currentBid: String(openingBid),
    windowMs: String(windowSeconds * 1000),
    extensionCount: '0',
    maxExtensions: String(maxAutoExtensions),
    minUndercut: String(minUndercut),
    windowEndsAt: '0',
    leaderParticipantId: '',
    leaderAlias: '',
    useLandedRate: useLandedRate ? '1' : '0',
    equityValue: String(equityValue),
    totalUnitsPerYear: String(totalUnitsPerYear),
  });
}

export async function startAuctionClock(auctionId: number, windowSeconds: number) {
  const windowEndsAt = Date.now() + windowSeconds * 1000;
  await redis.hset(auctionKey(auctionId), { status: 'live', windowEndsAt: String(windowEndsAt) });
  return windowEndsAt;
}

// The two steps that take a promoted, scheduled auction live — factored out so both the precise
// in-process timer (vettingAuctionBridge.ts's seedAuctionStandalone) and the self-healing check
// below do exactly the same thing, not two independently-maintained copies of it.
export async function activateScheduledAuction(auctionId: number, windowSeconds: number): Promise<void> {
  await startAuctionClock(auctionId, windowSeconds);
  await Auction.update({ status: 'live' }, { where: { id: auctionId } });
}

const SCHEDULED_AUCTION_CHECK_INTERVAL_MS = 60 * 1000;

// Self-heals the vetting bridge's own documented gap: a server restart between promotion and the
// scheduled start time loses the in-process setTimeout that would have called
// activateScheduledAuction, leaving the auction stuck 'scheduled' forever with no automatic path
// out. Auction.scheduledStartAt is null for every manually-seeded (auctionAdmin.ts) auction — those
// go live immediately, no scheduling involved — so this only ever finds real promoted auctions.
export async function activateOverdueScheduledAuctions(): Promise<void> {
  const due = await Auction.findAll({ where: { status: 'scheduled', scheduledStartAt: { [Op.lte]: new Date() } } });
  for (const auction of due) {
    try {
      await activateScheduledAuction(auction.id, auction.windowSeconds);
      logger.info({ auctionId: auction.id }, '[AUCTION_SCHEDULE] check loop activated a missed scheduled auction');
    } catch (err) {
      logger.error({ err, auctionId: auction.id }, '[AUCTION_SCHEDULE] check loop failed to activate one auction — continuing');
    }
  }
}

// Same recursive-setTimeout, self-healing poll pattern already used for auction close-checking
// (auctionSocket.ts's startCloseCheckLoop) — one auction's error can't wedge every future tick, and
// a missed activation is caught within one interval of the server coming back up, not left stuck
// until someone notices.
export function startScheduledAuctionActivationLoop(): void {
  async function tick() {
    try {
      await activateOverdueScheduledAuctions();
    } catch (err) {
      logger.error({ err }, '[AUCTION_SCHEDULE] check loop failed');
    } finally {
      setTimeout(tick, SCHEDULED_AUCTION_CHECK_INTERVAL_MS);
    }
  }
  setTimeout(tick, SCHEDULED_AUCTION_CHECK_INTERVAL_MS);
}

// Restart resilience: rebuilds a 'live' auction's Redis state from its own MySQL row when Redis has
// lost it (a restart without persistence configured, or an eviction) — without this, the close-check
// loop in auctionSocket.ts finds a DB row that says 'live' with nothing in Redis to act on, and the
// auction sits stuck forever with no automatic path to close. Resumes from the last known price and
// leader (both mirrored into MySQL on every accepted bid — see the Auction model's own comment on
// currentLeaderParticipantId), not the original opening bid, so a recovered auction reflects real
// market state instead of silently discarding every bid placed before the state was lost. Two
// things are deliberately NOT recoverable this way and are accepted as the cost of this being a
// PoC without a fully durable event log: the extension count resets to 0 (generators get the
// benefit of the doubt after an infra hiccup rather than an unfair head start toward closing), and
// a brand new full window starts from now rather than whatever time was actually left.
export async function reconstructAuctionState(auction: Auction): Promise<void> {
  const resumeBid = Number(auction.currentLowestBid ?? auction.openingBid);
  await initAuctionState(
    auction.id,
    resumeBid,
    auction.windowSeconds,
    auction.maxAutoExtensions,
    Number(auction.minUndercut),
    auction.useLandedRate,
    Number(auction.equityValue ?? 0),
    Number(auction.totalUnitsPerYear ?? 0)
  );
  if (auction.currentLeaderParticipantId !== null) {
    await redis.hset(auctionKey(auction.id), {
      leaderParticipantId: String(auction.currentLeaderParticipantId),
      leaderAlias: auction.currentLeaderAlias ?? '',
    });
  }
  await startAuctionClock(auction.id, auction.windowSeconds);
}

// Computes the landed rate in JS, then feeds it into the existing, unmodified Lua compare-and-set
// script as the compared value — deliberately not touching SUBMIT_BID_LUA itself (its
// atomicity/race-condition correctness is hard-won, see its own comments); only what number feeds
// it changes. equityValue/totalUnitsPerYear are constant for the auction's lifetime (written once
// at initAuctionState), so reading them here outside the atomic script is safe.
export async function submitBid(auctionId: number, rate: number, returnPercent: number, participantId: number, alias: string) {
  const [useLandedRateRaw, equityValueRaw, totalUnitsPerYearRaw] = await redis.hmget(
    auctionKey(auctionId),
    'useLandedRate',
    'equityValue',
    'totalUnitsPerYear'
  );
  // A normal-rate auction never runs the formula, full stop — regardless of what
  // equityValue/totalUnitsPerYear happen to hold (they may be '0' or missing entirely for an
  // auction that was never a landed-rate auction), so there's no divide-by-zero path here.
  const landedRate =
    useLandedRateRaw === '1' ? computeLandedRate(rate, returnPercent, Number(equityValueRaw), Number(totalUnitsPerYearRaw)) : rate;

  const [outcome, valueOrReason, extra] = await redis.submitBid(
    auctionKey(auctionId),
    String(landedRate),
    String(Date.now()),
    String(participantId),
    alias
  );
  if (outcome === 'ACCEPTED') {
    return { accepted: true as const, landedRate, currentBid: Number(valueOrReason), windowEndsAt: Number(extra) };
  }
  return { accepted: false as const, landedRate, reason: valueOrReason, currentBid: Number(extra) };
}

export async function getAuctionState(auctionId: number): Promise<AuctionRedisState | null> {
  const raw = await redis.hgetall(auctionKey(auctionId));
  if (!raw.status) return null;
  return {
    status: raw.status as AuctionRedisState['status'],
    currentBid: Number(raw.currentBid),
    windowEndsAt: raw.windowEndsAt && raw.windowEndsAt !== '0' ? Number(raw.windowEndsAt) : null,
    windowMs: Number(raw.windowMs),
    extensionCount: Number(raw.extensionCount),
    maxExtensions: Number(raw.maxExtensions),
    minUndercut: Number(raw.minUndercut),
    leaderParticipantId: raw.leaderParticipantId ? Number(raw.leaderParticipantId) : null,
    leaderAlias: raw.leaderAlias || null,
    equityValue: Number(raw.equityValue),
    totalUnitsPerYear: Number(raw.totalUnitsPerYear),
    useLandedRate: raw.useLandedRate === '1',
  };
}

export async function markAuctionClosed(auctionId: number) {
  await redis.hset(auctionKey(auctionId), { status: 'closed' });
}

interface AuditedBidInput {
  auctionId: number;
  participantId: number;
  alias: string;
  amount: string;
  rate: string;
  returnPercent: string;
  accepted: boolean;
  rejectReason: string | null;
  ipHash: string | null;
}

// Prevents two near-simultaneous bids for the same auction from forking the hash chain (both
// reading the same "last row" and computing the same prevHash). Earlier versions of this tried to
// serialize the read-then-write with a lock — first an in-memory Map (correct, but only within a
// single process), then a MySQL advisory lock (GET_LOCK/RELEASE_LOCK) that turned out to have a
// real bug: releasing the lock happened before the enclosing transaction actually committed, since
// advisory locks are session-scoped and take effect immediately regardless of transaction state —
// so the next writer could acquire the lock and read stale data before the previous writer's
// insert was even visible, forking the chain anyway. Verified live: 15 truly concurrent bids
// reliably produced exactly this fork.
//
// This replaces locking entirely with a real database constraint plus retry: a unique index on
// (auction_id, prev_hash) — see the migration and both models' own comments — means two writers
// racing to extend the chain from the same prevHash can't both succeed; the database itself
// rejects the second insert, which is caught below and retried against the now-current chain. This
// needs no lock, no session/connection pinning, and is correct across any number of server
// instances for free, since the constraint lives in MySQL, not in any one process's memory.
//
// Verified live at two different contention levels: 15 concurrent bids for an auction already a
// few rows into its chain retried cleanly; 30 truly simultaneous *first-ever* bids for a brand-new
// auction (the worst case — every one of them starts from the same empty prevHash, so only one can
// win and the other 29 all collide at once) needed the randomized backoff below to keep retrying
// in lockstep with each other from exhausting a small attempt budget — without it, a whole losing
// cohort tends to retry at the same instant and re-collide with each other repeatedly.
const MAX_CHAIN_INSERT_ATTEMPTS = 20;

// Tamper-evidence chain (AUCTION_PLAN.md standard): hash = SHA-256(prevHash + this row's content).
// This is the only place that should ever write an AuctionBid row — and it deliberately goes
// through AuctionBidAudit (the restricted SELECT+INSERT-only connection), not the main AuctionBid
// model, so an application bug or injection reachable through the app's normal DB credentials
// still can't UPDATE/DELETE an existing audit row.
export async function appendAuditedBid(input: AuditedBidInput) {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_CHAIN_INSERT_ATTEMPTS; attempt++) {
    const lastRow = await AuctionBidAudit.findOne({
      where: { auctionId: input.auctionId },
      order: [['id', 'DESC']],
    });
    const prevHash = lastRow?.hash ?? '';
    // Normalized to the exact form the DECIMAL(10,4) column stores/returns (e.g. "7" -> "7.0000")
    // — hashing the pre-insert value instead would make every future verification pass (read the
    // row, recompute, compare) report a false mismatch even with zero tampering, since MySQL
    // silently reformats DECIMAL values on write.
    const normalizedAmount = Number(input.amount).toFixed(4);
    // rate/returnPercent are hashed into the chain too, not just the derived amount — otherwise the
    // tamper-evidence chain proves a landed rate was recorded but not what raw inputs produced it.
    const normalizedRate = Number(input.rate).toFixed(4);
    const normalizedReturnPercent = Number(input.returnPercent).toFixed(2);
    const content = JSON.stringify({
      auctionId: input.auctionId,
      participantId: input.participantId,
      alias: input.alias,
      amount: normalizedAmount,
      rate: normalizedRate,
      returnPercent: normalizedReturnPercent,
      accepted: input.accepted,
      rejectReason: input.rejectReason,
      ipHash: input.ipHash,
    });
    const hash = crypto
      .createHash('sha256')
      .update(prevHash + content)
      .digest('hex');

    let row: AuctionBidAudit;
    try {
      row = await AuctionBidAudit.create({ ...input, prevHash, hash });
    } catch (err) {
      // Someone else's insert landed between our read and our write, claiming this exact
      // (auctionId, prevHash) pair first — the database caught it, so retry against whatever the
      // chain looks like now. Any other error (a real DB problem) should propagate as-is, same as
      // before this retry loop existed.
      if (err instanceof UniqueConstraintError) {
        lastError = err;
        // A small randomized delay, growing with attempt count — without it, a whole cohort that
        // lost together tends to retry together and immediately re-collide with each other again,
        // burning through the attempt budget without ever spreading out enough to succeed.
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 15 * attempt));
        continue;
      }
      throw err;
    }

    // Second, independent record of the same event — see localAuditLog.ts for why this exists
    // alongside (not instead of) the DB row. Written after the DB insert succeeds: if this file
    // write fails, the DB row (the primary record) is already durable and this isn't worth
    // failing the whole bid over.
    try {
      appendToLocalAuditLog({
        auctionId: input.auctionId,
        participantId: input.participantId,
        alias: input.alias,
        amount: normalizedAmount,
        rate: normalizedRate,
        returnPercent: normalizedReturnPercent,
        accepted: input.accepted,
        rejectReason: input.rejectReason,
        ipHash: input.ipHash,
        prevHash,
        hash,
      });
    } catch (err) {
      logger.error({ err }, '[AUDIT_LOG] failed to write local audit file');
    }

    return row;
  }
  // Only reachable if MAX_CHAIN_INSERT_ATTEMPTS consecutive attempts all lost the race — with a
  // handful of bidders this would need to happen 5 times in a row, vanishingly unlikely; treated as
  // a real failure rather than retried forever, so a pathological case can't hang a bid indefinitely.
  throw lastError instanceof Error ? lastError : new Error(`Failed to append audited bid for auction ${input.auctionId} after ${MAX_CHAIN_INSERT_ATTEMPTS} attempts`);
}

// Collusion-monitoring control: not proof of anything, just investigation leads — flags patterns
// worth a human look, same framing as REGULATORY_CERTIFICATION_RESEARCH.md's checklist ("alerts
// are investigation leads, not automatic proof"). Runs once at close over the full accepted-bid
// chronology already being assembled for the result summary, so it's effectively free to compute.
const RAPID_BID_THRESHOLD_MS = 2000;

function detectCollusionFlags(bids: AuctionBid[]): string[] {
  const flags: string[] = [];
  const accepted = bids.filter((b) => b.accepted);

  // Same IP behind multiple different aliases — possible sock-puppet bidders.
  const aliasesByIp = new Map<string, Set<string>>();
  for (const b of bids) {
    if (!b.ipHash) continue;
    const set = aliasesByIp.get(b.ipHash) ?? new Set<string>();
    set.add(b.alias);
    aliasesByIp.set(b.ipHash, set);
  }
  for (const [ipHash, aliases] of aliasesByIp) {
    if (aliases.size > 1) {
      flags.push(`Shared IP across ${aliases.size} aliases (${[...aliases].join(', ')}), ip_hash=${ipHash.slice(0, 12)}…`);
    }
  }

  // Unnaturally rapid consecutive bids from the same alias — possible automated/bot bidding.
  const byAlias = new Map<string, AuctionBid[]>();
  for (const b of accepted) {
    const list = byAlias.get(b.alias) ?? [];
    list.push(b);
    byAlias.set(b.alias, list);
  }
  for (const [alias, list] of byAlias) {
    for (let i = 1; i < list.length; i++) {
      const gapMs = list[i].createdAt.getTime() - list[i - 1].createdAt.getTime();
      if (gapMs >= 0 && gapMs < RAPID_BID_THRESHOLD_MS) {
        flags.push(`Rapid consecutive bids from ${alias} (${gapMs}ms apart)`);
      }
    }
  }

  return flags;
}

// "Automated result certificate" control: a verifiable snapshot of the whole record — rules in
// effect, full bid chronology (including each bid's own hash-chain entry), and the winner — hashed
// as one package. Not a real PKI signature (see AUCTION_MVP_PLAN.md), but enough for a customer or
// auditor to detect if the summary they were handed doesn't match what's actually in the log.
export async function buildAndStoreResultSummary(
  auctionId: number,
  winnerParticipantId: number | null,
  winnerAlias: string | null,
  winningBid: number
) {
  const auction = await Auction.findByPk(auctionId);
  const bids = await AuctionBid.findAll({ where: { auctionId }, order: [['id', 'ASC']] });

  const summary = {
    auctionId,
    title: auction?.title ?? null,
    resultType: RESULT_TYPE,
    disclosure: RESULT_DISCLOSURE,
    rules: {
      windowSeconds: auction?.windowSeconds ?? null,
      maxAutoExtensions: auction?.maxAutoExtensions ?? null,
      // Mirrored into this same row right before this function is called (see auctionSocket.ts's
      // close-tick) — the actual number used, not just the cap, so the permanent record shows what
      // really happened rather than only what was allowed to happen.
      extensionsUsed: auction?.currentExtensionCount ?? null,
      // Read from this specific auction's own record, not the live MIN_UNDERCUT constant — if the
      // constant is ever changed later, this stays accurate to what actually applied when this
      // auction ran (see the field's own comment on the Auction model for why).
      minUndercut: auction?.minUndercut ?? String(MIN_UNDERCUT),
    },
    openingBid: auction?.openingBid ?? null,
    winnerParticipantId,
    winnerAlias,
    winningBid,
    bidChronology: bids.map((b) => ({
      alias: b.alias,
      amount: b.amount,
      rate: b.rate,
      returnPercent: b.returnPercent,
      accepted: b.accepted,
      rejectReason: b.rejectReason,
      createdAt: b.createdAt,
      hash: b.hash,
    })),
    // Investigation leads, not proof — see detectCollusionFlags's own comment.
    collusionFlags: detectCollusionFlags(bids),
    // Forensic readiness: ties this specific result to the exact backend code that produced it —
    // see version.ts.
    codeVersion: DEPLOYED_CODE_VERSION,
    closedAt: new Date().toISOString(),
  };

  const resultSummaryJson = JSON.stringify(summary);
  const resultHash = crypto.createHash('sha256').update(resultSummaryJson).digest('hex');
  await Auction.update({ resultSummaryJson, resultHash }, { where: { id: auctionId } });
  return { resultSummaryJson, resultHash };
}
