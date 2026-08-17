import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  sanitizeAmountForAudit,
  appendAuditedBid,
  initAuctionState,
  startAuctionClock,
  submitBid,
  getAuctionState,
  markAuctionClosed,
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
      accepted: true,
      rejectReason: null,
      ipHash: null,
    });
    const second = await appendAuditedBid({
      auctionId,
      participantId: 2,
      alias: 'GEN-B',
      amount: '6.30',
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
      accepted: true,
      rejectReason: null,
      ipHash: 'somehash',
    });
    const crypto = await import('node:crypto');
    const normalizedAmount = Number(row.amount).toFixed(4);
    const content = JSON.stringify({
      auctionId,
      participantId: 1,
      alias: 'GEN-A',
      amount: normalizedAmount,
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
    await initAuctionState(auctionId, 10, 60, 3, MIN_UNDERCUT);
    await startAuctionClock(auctionId, 60);
  });

  afterEach(async () => {
    await cleanupAuction(auctionId);
  });

  it('accepts a bid at least MIN_UNDERCUT below the current lowest', async () => {
    const result = await submitBid(auctionId, 10 - MIN_UNDERCUT, 1, 'GEN-A');
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.currentBid).toBeCloseTo(10 - MIN_UNDERCUT, 4);
    }
  });

  it('rejects a bid that does not undercut by at least MIN_UNDERCUT', async () => {
    const result = await submitBid(auctionId, 10, 1, 'GEN-A');
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toBe('NOT_LOW_ENOUGH');
    }
  });

  it('rejects a bid on an auction that is not live', async () => {
    await markAuctionClosed(auctionId);
    const result = await submitBid(auctionId, 5, 1, 'GEN-A');
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toBe('AUCTION_NOT_LIVE');
    }
  });

  it('resets the countdown window on an accepted bid, up to the extension cap', async () => {
    const before = await getAuctionState(auctionId);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = await submitBid(auctionId, 9, 1, 'GEN-A');
    expect(result.accepted).toBe(true);
    const after = await getAuctionState(auctionId);
    expect(after?.extensionCount).toBe((before?.extensionCount ?? 0) + 1);
    if (result.accepted) {
      expect(after?.windowEndsAt).toBe(result.windowEndsAt);
    }
  });

  it('does not extend the window once maxAutoExtensions is exhausted', async () => {
    // maxAutoExtensions was set to 3 in beforeEach — burn through all of them first.
    await submitBid(auctionId, 9, 1, 'GEN-A');
    await submitBid(auctionId, 8, 1, 'GEN-A');
    await submitBid(auctionId, 7, 1, 'GEN-A');
    const stateBefore = await getAuctionState(auctionId);
    const result = await submitBid(auctionId, 6, 1, 'GEN-A');
    expect(result.accepted).toBe(true);
    const stateAfter = await getAuctionState(auctionId);
    // Extension count stays capped and the window end time is unchanged — the bid is still
    // accepted (a lower price is a lower price), it just no longer buys more time.
    expect(stateAfter?.extensionCount).toBe(3);
    expect(stateAfter?.windowEndsAt).toBe(stateBefore?.windowEndsAt);
  });
});
