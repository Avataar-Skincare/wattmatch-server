import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  sanitizeAmountForAudit,
  computeLandedRate,
  appendAuditedBid,
  initAuctionState,
  startAuctionClock,
  submitBid,
  getAuctionState,
  markAuctionClosed,
  activateOverdueScheduledAuctions,
  MAX_BID_AMOUNT,
  MIN_UNDERCUT,
} from './auctionEngine.js';
import { AuctionBidAudit } from '../models/AuctionBidAudit.js';
// Cleanup deliberately uses AuctionBid (the main, full-access connection), not AuctionBidAudit —
// the latter is bound to the restricted audit DB user, which by design has only SELECT+INSERT on
// this table (see AuctionBidAudit's own comment) and correctly cannot run a DELETE at all. Reads
// in these tests still go through AuctionBidAudit/appendAuditedBid, exercising the real restricted
// path; only cleanup needs the unrestricted connection.
import { AuctionBid } from '../models/AuctionBid.js';
import { Auction } from '../models/Auction.js';
import { redis } from '../lib/redis.js';

// A distinct, high-range id per test *run* (not a fixed constant) so these never collide with real
// seeded auctions (normal auto-increment ids starting from 1) — integration tests here hit the
// same real MySQL/Redis the dev server uses, not mocks, so isolation is by id range plus explicit
// cleanup, not a separate test database. Time-based rather than fixed specifically so that if a
// run ever crashes before its afterEach cleanup completes (as happened once during development of
// this very file), the *next* run still gets a fresh, non-colliding range instead of silently
// reading that leftover data and reporting a false failure.
let nextTestAuctionId = 900_000_000 + (Date.now() % 90_000_000);
function freshAuctionId(): number {
  return nextTestAuctionId++;
}

async function cleanupAuction(auctionId: number) {
  await AuctionBid.destroy({ where: { auctionId } });
  await redis.del(`auction:${auctionId}`);
}

describe('sanitizeAmountForAudit', () => {
  it('clamps a value above MAX_BID_AMOUNT down to the max, as a string', () => {
    expect(sanitizeAmountForAudit(MAX_BID_AMOUNT + 500)).toBe(String(MAX_BID_AMOUNT));
  });

  it('clamps a negative value up to -MAX_BID_AMOUNT, as a string', () => {
    expect(sanitizeAmountForAudit(-MAX_BID_AMOUNT - 500)).toBe(String(-MAX_BID_AMOUNT));
  });

  it('passes an in-range value through unchanged', () => {
    expect(sanitizeAmountForAudit(6.5)).toBe('6.5');
  });

  it('maps NaN/Infinity to "0" rather than producing an unparseable string', () => {
    expect(sanitizeAmountForAudit(NaN)).toBe('0');
    expect(sanitizeAmountForAudit(Infinity)).toBe('0');
    expect(sanitizeAmountForAudit(-Infinity)).toBe('0');
  });
});

describe('computeLandedRate', () => {
  it('returns the raw rate unchanged at 0% returns', () => {
    expect(computeLandedRate(10, 0, 500, 1000)).toBe(10);
  });

  it('discounts the rate proportionally to returns% × equityValue / totalUnitsPerYear', () => {
    // 10 - (50/100 * 1000 / 500) = 10 - 1 = 9
    expect(computeLandedRate(10, 50, 1000, 500)).toBeCloseTo(9, 6);
  });

  it('can go negative for a high enough return%', () => {
    // 10 - (100/100 * 5000 / 500) = 10 - 10 = 0; push equityValue higher to go negative
    expect(computeLandedRate(10, 100, 6000, 500)).toBeLessThan(0);
  });
});

describe('appendAuditedBid — hash chain integrity', () => {
  let auctionId: number;

  beforeEach(() => {
    auctionId = freshAuctionId();
  });

  afterEach(async () => {
    await cleanupAuction(auctionId);
  });

  it('the first bid for an auction has an empty prevHash', async () => {
    const row = await appendAuditedBid({
      auctionId,
      participantId: 1,
      alias: 'GEN-A',
      amount: '6.50',
      rate: '6.50',
      returnPercent: '0',
      accepted: true,
      rejectReason: null,
      ipHash: null,
    });
    expect(row.prevHash).toBe('');
    expect(row.hash).toBeTruthy();
  });

  it('chains each subsequent bid to the previous row\'s hash', async () => {
    const first = await appendAuditedBid({
      auctionId,
      participantId: 1,
      alias: 'GEN-A',
      amount: '6.50',
      rate: '6.50',
      returnPercent: '0',
      accepted: true,
      rejectReason: null,
      ipHash: null,
    });
    const second = await appendAuditedBid({
      auctionId,
      participantId: 2,
      alias: 'GEN-B',
      amount: '6.30',
      rate: '6.30',
      returnPercent: '0',
      accepted: true,
      rejectReason: null,
      ipHash: null,
    });
    expect(second.prevHash).toBe(first.hash);
  });

  // This is the regression test for a real bug found and fixed this session: an earlier
  // implementation serialized concurrent writes with a MySQL advisory lock that released before
  // its enclosing transaction actually committed, letting a concurrent writer read stale data and
  // fork the chain. Verified live at the time (15-way and 30-way concurrent bids reliably forked
  // it); this test exists so that regression can never silently come back unnoticed.
  it('N truly concurrent bids for the same brand-new auction never fork the chain', async () => {
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        appendAuditedBid({
          auctionId,
          participantId: i,
          alias: `GEN-${i}`,
          amount: String(100 - i),
          rate: String(100 - i),
          returnPercent: '0',
          accepted: false,
          rejectReason: 'TEST',
          ipHash: null,
        })
      )
    );

    const rows = await AuctionBidAudit.findAll({ where: { auctionId }, order: [['id', 'ASC']] });
    expect(rows).toHaveLength(N);

    const seenHashes = new Set<string>();
    let expectedPrev = '';
    for (const row of rows) {
      expect(row.prevHash).toBe(expectedPrev);
      expect(seenHashes.has(row.hash)).toBe(false);
      seenHashes.add(row.hash);
      expectedPrev = row.hash;
    }
  });

  it('recomputing the hash from stored fields matches the stored hash (tamper-evidence check)', async () => {
    const row = await appendAuditedBid({
      auctionId,
      participantId: 1,
      alias: 'GEN-A',
      amount: '6.50',
      rate: '6.50',
      returnPercent: '0',
      accepted: true,
      rejectReason: null,
      ipHash: 'somehash',
    });
    const crypto = await import('node:crypto');
    const normalizedAmount = Number(row.amount).toFixed(4);
    const normalizedRate = Number(row.rate).toFixed(4);
    const normalizedReturnPercent = Number(row.returnPercent).toFixed(2);
    const content = JSON.stringify({
      auctionId,
      participantId: 1,
      alias: 'GEN-A',
      amount: normalizedAmount,
      rate: normalizedRate,
      returnPercent: normalizedReturnPercent,
      accepted: true,
      rejectReason: null,
      ipHash: 'somehash',
    });
    const recomputed = crypto.createHash('sha256').update(row.prevHash + content).digest('hex');
    expect(recomputed).toBe(row.hash);
  });
});

describe('submitBid — Redis compare-and-swap', () => {
  let auctionId: number;

  beforeEach(async () => {
    auctionId = freshAuctionId();
    // A normal-rate auction by default — matches these tests' original pre-landed-rate behavior
    // (returnPercent is always 0 below anyway, so landedRate === rate either way).
    await initAuctionState(auctionId, 10, 60, 3, MIN_UNDERCUT, false);
    await startAuctionClock(auctionId, 60);
  });

  afterEach(async () => {
    await cleanupAuction(auctionId);
  });

  it('accepts a bid at least MIN_UNDERCUT below the current lowest', async () => {
    const result = await submitBid(auctionId, 10 - MIN_UNDERCUT, 0, 1, 'GEN-A');
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.currentBid).toBeCloseTo(10 - MIN_UNDERCUT, 4);
    }
  });

  it('rejects a bid that does not undercut by at least MIN_UNDERCUT', async () => {
    const result = await submitBid(auctionId, 10, 0, 1, 'GEN-A');
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toBe('NOT_LOW_ENOUGH');
    }
  });

  it('rejects a bid on an auction that is not live', async () => {
    await markAuctionClosed(auctionId);
    const result = await submitBid(auctionId, 5, 0, 1, 'GEN-A');
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toBe('AUCTION_NOT_LIVE');
    }
  });

  it('resets the countdown window on an accepted bid, up to the extension cap', async () => {
    const before = await getAuctionState(auctionId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await submitBid(auctionId, 9, 0, 1, 'GEN-A');
    expect(result.accepted).toBe(true);
    const after = await getAuctionState(auctionId);
    expect(after?.extensionCount).toBe((before?.extensionCount ?? 0) + 1);
    if (result.accepted) {
      expect(after?.windowEndsAt).toBe(result.windowEndsAt);
    }
  });

  it('does not extend the window once maxAutoExtensions is exhausted', async () => {
    // maxAutoExtensions was set to 3 in beforeEach — burn through all of them first.
    await submitBid(auctionId, 9, 0, 1, 'GEN-A');
    await submitBid(auctionId, 8, 0, 1, 'GEN-A');
    await submitBid(auctionId, 7, 0, 1, 'GEN-A');
    const stateBefore = await getAuctionState(auctionId);
    const result = await submitBid(auctionId, 6, 0, 1, 'GEN-A');
    expect(result.accepted).toBe(true);
    const stateAfter = await getAuctionState(auctionId);
    // Extension count stays capped and the window end time is unchanged — the bid is still
    // accepted (a lower price is a lower price), it just no longer buys more time.
    expect(stateAfter?.extensionCount).toBe(3);
    expect(stateAfter?.windowEndsAt).toBe(stateBefore?.windowEndsAt);
  });

  // The per-tender toggle's whole point: a normal-rate auction must never run the formula, even if
  // a caller somehow sends a nonzero returnPercent — landedRate must equal the raw rate exactly.
  it('a normal-rate auction ignores returnPercent entirely', async () => {
    const result = await submitBid(auctionId, 9, 75, 1, 'GEN-A');
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.landedRate).toBe(9);
      expect(result.currentBid).toBe(9);
    }
  });

  // The actual behavior change this feature exists for: the leader is decided by landed rate, not
  // raw rate — a higher raw rate can still win if its returns% discounts it low enough.
  it('a higher raw rate with a strong enough return% out-ranks a lower raw rate with none', async () => {
    // Override this auction's formula inputs so the arithmetic is deliberately clean: equityValue
    // 1000, totalUnitsPerYear 500. Rate 9 with 0% returns lands at 9. Rate 9.5 with 40% returns
    // lands at 9.5 - (0.4 * 1000/500) = 9.5 - 0.8 = 8.7 — clearly lower despite the higher raw rate.
    await initAuctionState(auctionId, 100, 60, 3, MIN_UNDERCUT, true, 1000, 500);
    await startAuctionClock(auctionId, 60);

    const first = await submitBid(auctionId, 9, 0, 1, 'GEN-A');
    expect(first.accepted).toBe(true);
    if (first.accepted) expect(first.landedRate).toBeCloseTo(9, 6);

    const second = await submitBid(auctionId, 9.5, 40, 2, 'GEN-B');
    expect(second.accepted).toBe(true);
    if (second.accepted) {
      expect(second.landedRate).toBeCloseTo(8.7, 6);
      expect(second.currentBid).toBeCloseTo(8.7, 6);
    }

    const state = await getAuctionState(auctionId);
    expect(state?.leaderAlias).toBe('GEN-B');
  });
});

describe('activateOverdueScheduledAuctions', () => {
  const createdAuctionIds: number[] = [];

  afterEach(async () => {
    for (const id of createdAuctionIds.splice(0)) {
      await Auction.destroy({ where: { id } });
      await redis.del(`auction:${id}`);
    }
  });

  it('activates a scheduled auction whose start time has already passed', async () => {
    const auction = await Auction.create({
      title: 'Overdue scheduled auction',
      status: 'scheduled',
      openingBid: '10.0000',
      windowSeconds: 60,
      maxAutoExtensions: 3,
      minUndercut: '0.01',
      scheduledStartAt: new Date(Date.now() - 60_000),
    });
    createdAuctionIds.push(auction.id);

    await activateOverdueScheduledAuctions();

    await auction.reload();
    expect(auction.status).toBe('live');
    const state = await getAuctionState(auction.id);
    expect(state?.status).toBe('live');
  });

  it('leaves a scheduled auction whose start time is still in the future alone', async () => {
    const auction = await Auction.create({
      title: 'Not yet due auction',
      status: 'scheduled',
      openingBid: '10.0000',
      windowSeconds: 60,
      maxAutoExtensions: 3,
      minUndercut: '0.01',
      scheduledStartAt: new Date(Date.now() + 60_000),
    });
    createdAuctionIds.push(auction.id);

    await activateOverdueScheduledAuctions();

    await auction.reload();
    expect(auction.status).toBe('scheduled');
  });

  it('ignores a scheduled auction with no scheduledStartAt (manually seeded)', async () => {
    const auction = await Auction.create({
      title: 'Manually seeded auction',
      status: 'scheduled',
      openingBid: '10.0000',
      windowSeconds: 60,
      maxAutoExtensions: 3,
      minUndercut: '0.01',
    });
    createdAuctionIds.push(auction.id);

    await activateOverdueScheduledAuctions();

    await auction.reload();
    expect(auction.status).toBe('scheduled');
  });
});
