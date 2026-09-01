import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { setupAuctionSocket } from './auctionSocket.js';
import { Auction } from '../models/Auction.js';
import { AuctionParticipant } from '../models/AuctionParticipant.js';
import { AuctionBid } from '../models/AuctionBid.js';
import { redis } from '../lib/redis.js';
import { encryptField } from '../lib/fieldEncryption.js';
import { generateJti, signJoinToken } from '../lib/auctionTokens.js';
import { initAuctionState, startAuctionClock } from '../services/auctionEngine.js';

// This file previously didn't exist at all — the entire socket layer had zero direct test
// coverage (see the platform audit's H10 finding), including the in-progress fix these tests were
// added alongside: a 24h Redis TTL on closed-auction state, a MySQL fallback for late joiners once
// that TTL has expired, and re-deriving the DB mirror fields from Redis at close instead of trusting
// the last per-bid write (C1). Runs against the real HTTP/Socket.io server, real MySQL, and real
// Redis, consistent with this project's practice elsewhere (see auctionEngine.test.ts's own note).

let httpServer: http.Server;
let port: number;
let io: ReturnType<typeof setupAuctionSocket>;

beforeAll(async () => {
  httpServer = http.createServer();
  io = setupAuctionSocket(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  port = (httpServer.address() as AddressInfo).port;
});

afterAll(async () => {
  io.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

// Hits the same real MySQL/Redis the dev server uses, not a separate test database (same practice
// as auctionEngine.test.ts) — so isolation has to hold up against auto_increment on the real table,
// not just against other tests. A per-run-fixed base derived from Date.now() (as tried initially)
// clusters tightly across repeated nearby runs: each explicit high id this file inserts bumps
// wattmatch_auctions' real AUTO_INCREMENT to match it (standard MySQL/InnoDB behavior for an
// explicit PK above the current counter), so a run seconds later computes ids only slightly higher
// — landing right where OTHER test files' auto-incremented inserts are now also landing. Drawing an
// independent, uniformly random id on every single call (not derived from the clock at module load)
// avoids that clustering entirely.
function freshAuctionId(): number {
  return crypto.randomInt(200_000_000, 800_000_000);
}

const createdAuctionIds: number[] = [];

afterEach(async () => {
  const ids = createdAuctionIds.splice(0);
  for (const id of ids) {
    await AuctionBid.destroy({ where: { auctionId: id } });
    await AuctionParticipant.destroy({ where: { auctionId: id } });
    await Auction.destroy({ where: { id } });
    await redis.del(`auction:${id}`);
  }
});

function connectClient(token: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(`http://localhost:${port}`, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function waitForEvent<T>(socket: ClientSocket, event: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

async function createClosedAuction(finalBid: string, leaderAlias: string | null) {
  const auctionId = freshAuctionId();
  createdAuctionIds.push(auctionId);
  await Auction.create({
    id: auctionId,
    title: 'Test auction',
    status: 'closed',
    openingBid: '10.0000',
    currentLowestBid: finalBid,
    currentLeaderAlias: leaderAlias,
    windowSeconds: 480,
    maxAutoExtensions: 8,
    minUndercut: '0.01',
  });
  const jti = generateJti();
  const participant = await AuctionParticipant.create({
    auctionId,
    organizationName: await encryptField('Test Co'),
    alias: 'Late Joiner',
    role: 'buyer',
    joinTokenId: jti,
  });
  const token = await signJoinToken({ auctionId, participantId: participant.id, alias: 'Late Joiner', jti });
  return { auctionId, token };
}

describe('auction:closed on connect — Redis-state fallback (H10 / C1)', () => {
  it('serves the result straight from Redis when the closed-state key is still present', async () => {
    const { auctionId, token } = await createClosedAuction('4.5000', 'Winner Co');
    await redis.hset(`auction:${auctionId}`, {
      status: 'closed',
      currentBid: '4.5',
      windowMs: '480000',
      extensionCount: '0',
      maxExtensions: '8',
      minUndercut: '0.01',
      windowEndsAt: '0',
      leaderParticipantId: '',
      leaderAlias: 'Winner Co',
      useLandedRate: '0',
      equityValue: '0',
      totalUnitsPerYear: '0',
    });

    const socket = await connectClient(token);
    const payload = await waitForEvent<{ winnerAlias: string | null; winningBid: number }>(socket, 'auction:closed');
    expect(payload).toMatchObject({ winnerAlias: 'Winner Co', winningBid: 4.5 });
    socket.disconnect();
  });

  it('falls back to the DB mirror once the Redis key is gone — simulating the 24h TTL having expired', async () => {
    const { auctionId, token } = await createClosedAuction('6.2500', 'Fallback Co');
    await redis.del(`auction:${auctionId}`);

    const socket = await connectClient(token);
    const payload = await waitForEvent<{ winnerAlias: string | null; winningBid: number }>(socket, 'auction:closed');
    expect(payload).toMatchObject({ winnerAlias: 'Fallback Co', winningBid: 6.25 });
    socket.disconnect();
  });

  it('DB fallback also forwards useLandedRate/extensionCount/maxExtensions/minUndercut from the Auction row, not zeroed defaults', async () => {
    // Deliberately non-default values (createClosedAuction's own defaults are useLandedRate: false,
    // currentExtensionCount: 0) — a test that only checked the defaults could pass even if the
    // fallback path silently dropped these fields and the client happened to render 0/false anyway.
    const auctionId = freshAuctionId();
    createdAuctionIds.push(auctionId);
    await Auction.create({
      id: auctionId,
      title: 'Test auction',
      status: 'closed',
      openingBid: '10.0000',
      currentLowestBid: '9.4000',
      currentLeaderAlias: 'Landed Rate Co',
      windowSeconds: 480,
      maxAutoExtensions: 8,
      minUndercut: '0.05',
      useLandedRate: true,
      currentExtensionCount: 3,
    });
    const jti = generateJti();
    const participant = await AuctionParticipant.create({
      auctionId,
      organizationName: await encryptField('Test Co'),
      alias: 'Late Joiner',
      role: 'buyer',
      joinTokenId: jti,
    });
    const token = await signJoinToken({ auctionId, participantId: participant.id, alias: 'Late Joiner', jti });
    await redis.del(`auction:${auctionId}`);

    const socket = await connectClient(token);
    const payload = await waitForEvent<{
      useLandedRate: boolean;
      extensionCount: number;
      maxExtensions: number;
      minUndercut: number;
    }>(socket, 'auction:closed');
    expect(payload).toMatchObject({ useLandedRate: true, extensionCount: 3, maxExtensions: 8, minUndercut: 0.05 });
    socket.disconnect();
  });

  it('DB fallback uses openingBid when no bid was ever accepted (currentLowestBid stays null)', async () => {
    const { auctionId, token } = await createClosedAuction(null as unknown as string, null);
    await redis.del(`auction:${auctionId}`);

    const socket = await connectClient(token);
    const payload = await waitForEvent<{ winnerAlias: string | null; winningBid: number }>(socket, 'auction:closed');
    expect(payload).toMatchObject({ winnerAlias: null, winningBid: 10 });
    socket.disconnect();
  });

  it('does not emit auction:closed at all when Redis has nothing and the DB still shows it live', async () => {
    const auctionId = freshAuctionId();
    createdAuctionIds.push(auctionId);
    await Auction.create({
      id: auctionId,
      title: 'Still live',
      status: 'live',
      openingBid: '10.0000',
      windowSeconds: 480,
      maxAutoExtensions: 8,
      minUndercut: '0.01',
    });
    const jti = generateJti();
    const participant = await AuctionParticipant.create({
      auctionId,
      organizationName: await encryptField('Test Co'),
      alias: 'Watcher',
      role: 'buyer',
      joinTokenId: jti,
    });
    const token = await signJoinToken({ auctionId, participantId: participant.id, alias: 'Watcher', jti });

    const socket = await connectClient(token);
    let gotClosedEvent = false;
    socket.on('auction:closed', () => {
      gotClosedEvent = true;
    });
    // No good way to prove a negative deterministically other than waiting past a close-tick
    // interval and confirming nothing arrived.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(gotClosedEvent).toBe(false);
    socket.disconnect();
  });
});

describe('close-tick re-derives the DB mirror from Redis, not the last per-bid write (C1)', () => {
  it('overwrites a stale currentLowestBid/currentLeaderAlias with Redis state when the auction closes', async () => {
    const auctionId = freshAuctionId();
    createdAuctionIds.push(auctionId);
    await Auction.create({
      id: auctionId,
      title: 'Race test',
      status: 'live',
      openingBid: '10.0000',
      // Deliberately wrong — stands in for what an unordered per-bid mirror write could have left
      // behind (see auctionSocket.ts's bid:new handler comment on why these two writes race). The
      // close tick must overwrite both from Redis's own state, not trust whatever is here.
      currentLowestBid: '999.0000',
      currentLeaderAlias: 'Stale Wrong Leader',
      windowSeconds: 480,
      maxAutoExtensions: 8,
      minUndercut: '0.01',
    });
    await redis.hset(`auction:${auctionId}`, {
      status: 'live',
      currentBid: '4.2',
      windowMs: '480000',
      extensionCount: '0',
      maxExtensions: '8',
      minUndercut: '0.01',
      // Already elapsed — the close-check loop (started once for this whole file in beforeAll,
      // polling every 500ms) will close this auction on its very next tick.
      windowEndsAt: String(Date.now() - 1000),
      leaderParticipantId: '',
      leaderAlias: 'Real Leader',
      useLandedRate: '0',
      equityValue: '0',
      totalUnitsPerYear: '0',
    });

    await new Promise((resolve) => setTimeout(resolve, 1500));

    const auction = await Auction.findByPk(auctionId);
    expect(auction?.status).toBe('closed');
    expect(Number(auction?.currentLowestBid)).toBeCloseTo(4.2, 4);
    expect(auction?.currentLeaderAlias).toBe('Real Leader');
  });
});

describe('bid:new — happy path through the restructured accept/broadcast flow (C2)', () => {
  it('accepts a valid undercut bid, broadcasts state:update, and mirrors it onto the Auction row', async () => {
    const auctionId = freshAuctionId();
    createdAuctionIds.push(auctionId);
    await Auction.create({
      id: auctionId,
      title: 'Bid test',
      status: 'live',
      openingBid: '10.0000',
      windowSeconds: 480,
      maxAutoExtensions: 8,
      minUndercut: '0.01',
    });
    await initAuctionState(auctionId, 10, 480, 8, 0.01, false);
    await startAuctionClock(auctionId, 480);

    const jti = generateJti();
    const participant = await AuctionParticipant.create({
      auctionId,
      organizationName: await encryptField('Bidder Co'),
      alias: 'Bidder Co',
      role: 'generator',
      joinTokenId: jti,
      rulesAcceptedAt: new Date(),
    });
    const token = await signJoinToken({ auctionId, participantId: participant.id, alias: 'Bidder Co', jti });

    const socket = await connectClient(token);
    await waitForEvent(socket, 'state:sync');

    socket.emit('bid:new', { rate: 9.5, returnPercent: 0 });
    const update = await waitForEvent<{ currentBid: number; alias: string }>(socket, 'state:update');
    expect(update).toMatchObject({ currentBid: 9.5, alias: 'Bidder Co' });

    // Give the post-broadcast audit-log/DB-mirror write (now deliberately after the broadcast —
    // see bid:new's own comment) a moment to land before asserting on it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const auction = await Auction.findByPk(auctionId);
    expect(Number(auction?.currentLowestBid)).toBeCloseTo(9.5, 4);
    expect(auction?.currentLeaderAlias).toBe('Bidder Co');

    socket.disconnect();
  });
});
