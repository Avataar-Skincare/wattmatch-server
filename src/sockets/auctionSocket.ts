import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server as HTTPServer } from 'node:http';
import { verifyJoinToken, hashIp } from '../lib/auctionTokens.js';
import { redis } from '../lib/redis.js';
import { AuctionParticipant, type AuctionParticipantRole } from '../models/AuctionParticipant.js';
import { Auction } from '../models/Auction.js';
import { AuctionBid } from '../models/AuctionBid.js';
import {
  getAuctionState,
  submitBid,
  markAuctionClosed,
  appendAuditedBid,
  buildAndStoreResultSummary,
  releaseAuctionLock,
  reconstructAuctionState,
  RESULT_TYPE,
  RESULT_DISCLOSURE,
  MAX_BID_AMOUNT,
  sanitizeAmountForAudit,
} from '../services/auctionEngine.js';

// Single recurring poll, not a per-bid setTimeout reschedule — avoids Node event-loop-lag drift
// under bursty bidding. See AUCTION_MVP_PLAN.md.
const CLOSE_CHECK_INTERVAL_MS = 500;

// Matches the client's own feed cap (AuctionLivePage.tsx slices to 10) — a (re)joining client's
// feed was previously always empty ("No bids yet.") since the feed is otherwise only built from
// live state:update events received during that specific connection's lifetime, which makes a
// perfectly normal reconnect (or joining after the auction already closed) look like nothing
// happened yet, even mid- or post-auction.
const FEED_HISTORY_LIMIT = 10;

// Per-socket bid rate limit: bounds how fast one connection can submit bid attempts, valid or
// not — without this, a single client can hammer the Redis Lua script and (for every attempt,
// including rejected ones) the audit-log DB write, far faster than any real bidder would. This is
// deliberately a fixed-window counter keyed by socket.id, not by participant/alias — a reconnect
// gets a fresh socket.id and a fresh window, which is fine: the goal is bounding burst rate per
// connection, not a lifetime quota per bidder.
const BID_RATE_LIMIT_WINDOW_MS = 2000;
const BID_RATE_LIMIT_MAX = 5;
const bidRateState = new Map<string, { windowStart: number; count: number }>();

function isBidRateLimited(socketId: string): boolean {
  const now = Date.now();
  const state = bidRateState.get(socketId);
  if (!state || now - state.windowStart >= BID_RATE_LIMIT_WINDOW_MS) {
    bidRateState.set(socketId, { windowStart: now, count: 1 });
    return false;
  }
  state.count += 1;
  return state.count > BID_RATE_LIMIT_MAX;
}

// Single active session per participant, WhatsApp-Web style: a join link/token identifies a
// participant, not a specific tab — opening it a second time (another tab, another device) should
// take over, not silently create a second live bidder under the same alias. Keyed by
// "auctionId:participantId" -> the socket.id currently allowed to act as that participant.
// Emitting/disconnecting through `io` (not a local socket lookup) so this is correct even across
// multiple server instances once the Redis adapter has this auction's old socket on another node.
const activeSessionByParticipant = new Map<string, string>();

function sessionKeyFor(auctionId: number, participantId: number): string {
  return `${auctionId}:${participantId}`;
}

interface AuctionSocketData {
  auctionId: number;
  participantId: number;
  alias: string;
  role: AuctionParticipantRole;
  rulesAccepted: boolean;
}

export function setupAuctionSocket(httpServer: HTTPServer) {
  const io = new SocketIOServer<
    { 'bid:new': (payload: { amount: number }) => void; 'rules:accept': () => void },
    {
      'state:sync': (state: unknown) => void;
      'you:info': (payload: { alias: string; role: AuctionParticipantRole; rulesAccepted: boolean }) => void;
      'rules:accepted': () => void;
      'state:update': (payload: { currentBid: number; windowEndsAt: number; alias: string }) => void;
      'bid:rejected': (payload: { reason: string; currentBid?: number }) => void;
      'auction:closed': (payload: {
        winnerAlias: string | null;
        winningBid: number;
        resultType: string;
        disclosure: string;
      }) => void;
      'session:replaced': () => void;
      'feed:sync': (bids: { alias: string; amount: number }[]) => void;
    },
    Record<string, never>,
    AuctionSocketData
  >(httpServer, {
    cors: { origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173' },
    // Default path (/socket.io) — deliberately kept separate from /api/*, not nested under it.
    // Needs its own CloudFront cache behavior in production (WebSocket-aware: CachingDisabled +
    // AllViewer origin request policy) rather than piggybacking on the REST API's routing — see
    // AUCTION_PLAN.md's "Real-time transport" section for why and the exact setup steps.
  });

  // Multi-instance readiness: Socket.io's default adapter only broadcasts (io.to(room).emit) to
  // sockets connected to THIS process — with more than one server instance behind a load balancer,
  // a bid accepted on instance A would never reach a bidder's socket connected to instance B. This
  // makes broadcast fan-out correct across instances. It does NOT make the bid-acceptance path
  // itself multi-instance-safe — auctionEngine.ts's write lock is still a process-local Map, a
  // separate and larger change (see its own comment) — this only fixes delivery, not the race.
  const pubClient = redis.duplicate();
  const subClient = pubClient.duplicate();
  pubClient.on('error', (err: Error) => console.error('[AUCTION_SOCKET] Redis adapter pubClient error:', err));
  subClient.on('error', (err: Error) => console.error('[AUCTION_SOCKET] Redis adapter subClient error:', err));
  io.adapter(createAdapter(pubClient, subClient));

  // Identity is resolved ONCE at handshake, from the verified token, and bound to socket.data.
  // Never trust an id/alias arriving inside a later event payload — see AUCTION_PLAN.md's
  // real-time transport section on why (spoofing risk).
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) {
        console.warn(`[AUCTION_AUTH] [socket=${socket.id}] rejected: missing join token, ip=${socket.handshake.address}`);
        return next(new Error('Missing join token'));
      }
      const payload = verifyJoinToken(token);
      const participant = await AuctionParticipant.findOne({
        where: { id: payload.participantId, auctionId: payload.auctionId, joinTokenId: payload.jti },
      });
      if (!participant) {
        console.warn(`[AUCTION_AUTH] [socket=${socket.id}] rejected: unknown/revoked token for auction=${payload.auctionId} participant=${payload.participantId}, ip=${socket.handshake.address}`);
        return next(new Error('Unknown or revoked join token'));
      }
      socket.data.auctionId = payload.auctionId;
      socket.data.participantId = payload.participantId;
      socket.data.alias = payload.alias;
      socket.data.role = participant.role;
      socket.data.rulesAccepted = participant.rulesAcceptedAt !== null;
      next();
    } catch (err) {
      console.warn(`[AUCTION_AUTH] [socket=${socket.id}] rejected: invalid/expired token, ip=${socket.handshake.address}`, err instanceof Error ? err.message : err);
      next(new Error('Invalid or expired join token'));
    }
  });

  io.on('connection', async (socket) => {
    const { auctionId, participantId } = socket.data;
    const room = `auction:${auctionId}`;
    const sessionKey = sessionKeyFor(auctionId, participantId);

    // Take over any existing session for this same participant before doing anything else — the
    // old tab/device is told why it's being cut off, then force-disconnected. Using io.to/io.in
    // (not a local socket lookup) so this still works if the old socket happens to be connected to
    // a different server instance behind the Redis adapter.
    const previousSocketId = activeSessionByParticipant.get(sessionKey);
    if (previousSocketId && previousSocketId !== socket.id) {
      io.to(previousSocketId).emit('session:replaced');
      io.in(previousSocketId).disconnectSockets(true);
    }
    activeSessionByParticipant.set(sessionKey, socket.id);

    await socket.join(room);

    // On connect or reconnect, push current state from Redis — the source of truth, so a
    // dropped-and-reconnected client just re-syncs with no special-case logic.
    const state = await getAuctionState(auctionId);
    socket.emit('state:sync', state);
    socket.emit('you:info', { alias: socket.data.alias, role: socket.data.role, rulesAccepted: socket.data.rulesAccepted });

    // Backfill the bid feed from the durable record (MySQL), not just future live events — without
    // this, anyone who (re)connects mid-auction or after it's already closed sees an empty "No bids
    // yet." feed regardless of how much real bidding already happened, since the feed is otherwise
    // built purely from state:update events received during this one connection's lifetime.
    const recentBids = await AuctionBid.findAll({
      where: { auctionId, accepted: true },
      order: [['id', 'DESC']],
      limit: FEED_HISTORY_LIMIT,
      attributes: ['alias', 'amount'],
    });
    socket.emit(
      'feed:sync',
      recentBids.map((b) => ({ alias: b.alias, amount: Number(b.amount) }))
    );

    // Participant acknowledgement control: bidding is gated on this, not just a UI formality —
    // see the "Dispute and customer controls" checklist in REGULATORY_CERTIFICATION_RESEARCH.md.
    socket.on('rules:accept', async () => {
      if (socket.data.rulesAccepted) return;
      await AuctionParticipant.update(
        { rulesAcceptedAt: new Date() },
        { where: { id: socket.data.participantId } }
      );
      socket.data.rulesAccepted = true;
      socket.emit('rules:accepted');
    });

    socket.on('bid:new', async (payload) => {
      const { auctionId, participantId, alias } = socket.data;
      const amount = Number(payload?.amount);
      const ipHash = hashIp(socket.handshake.address);

      // Everything below can throw (a DB write, Redis) — without this, an unhandled rejection in
      // an async socket handler crashes the whole process (Node terminates on unhandled rejection
      // by default), taking down every other live auction along with it, not just this one bid.
      try {
        // A buyer's join link is a read-only spectator seat (see AuctionParticipant's role field) —
        // the UI never shows them a bid form, so reaching this at all means either a bug or someone
        // hand-crafting socket events. Not audit-logged as a market event (it isn't one); a console
        // line is enough to notice.
        if (socket.data.role !== 'generator') {
          console.warn(`[AUCTION_BID] [socket=${socket.id}] rejected: role=${socket.data.role} is not allowed to bid, auction=${auctionId} participant=${participantId}`);
          socket.emit('bid:rejected', { reason: 'NOT_A_BIDDER' });
          return;
        }

        // Checked first and deliberately NOT audit-logged like the other rejections below — logging
        // every over-limit attempt would itself be the DB-write amplification this limit exists to
        // prevent. A console line is enough to notice abuse without writing it to the audit trail.
        if (isBidRateLimited(socket.id)) {
          console.warn(`[AUCTION_BID] [socket=${socket.id}] rate-limited: auction=${auctionId} participant=${participantId}`);
          socket.emit('bid:rejected', { reason: 'RATE_LIMITED' });
          return;
        }

        // Every attempt is logged, including ones blocked before reaching the Redis compare-and-swap
        // — a rules-not-accepted or malformed-amount attempt is still a real audit-worthy event, not
        // just noise to discard (same principle as logging market-rejected bids).
        if (!socket.data.rulesAccepted) {
          await appendAuditedBid({
            auctionId,
            participantId,
            alias,
            amount: sanitizeAmountForAudit(amount),
            accepted: false,
            rejectReason: 'RULES_NOT_ACCEPTED',
            ipHash,
          });
          socket.emit('bid:rejected', { reason: 'RULES_NOT_ACCEPTED' });
          return;
        }

        // The Lua script only checks a bid is below the current lowest — with no floor or ceiling,
        // a negative amount would otherwise be accepted as a valid leading bid, and an amount
        // outside DECIMAL(10,4)'s range would throw on the DB insert below instead of being caught
        // here cleanly.
        if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_BID_AMOUNT) {
          await appendAuditedBid({
            auctionId,
            participantId,
            alias,
            amount: sanitizeAmountForAudit(amount),
            accepted: false,
            rejectReason: 'INVALID_AMOUNT',
            ipHash,
          });
          socket.emit('bid:rejected', { reason: 'INVALID_AMOUNT' });
          return;
        }

        const result = await submitBid(auctionId, amount, participantId, alias);

        await appendAuditedBid({
          auctionId,
          participantId,
          alias,
          amount: String(amount),
          accepted: result.accepted,
          rejectReason: result.accepted ? null : result.reason,
          ipHash,
        });

        if (result.accepted) {
          // currentLeaderParticipantId/currentLeaderAlias mirror Redis purely for restart
          // resilience (see reconstructAuctionState) — Redis stays the source of truth for bid
          // acceptance itself, this is never read on the normal live path.
          await Auction.update(
            { currentLowestBid: String(result.currentBid), currentLeaderParticipantId: participantId, currentLeaderAlias: alias },
            { where: { id: auctionId } }
          );
          io.to(room).emit('state:update', {
            currentBid: result.currentBid,
            windowEndsAt: result.windowEndsAt,
            alias,
          });
        } else {
          socket.emit('bid:rejected', { reason: result.reason, currentBid: result.currentBid });
        }
      } catch (err) {
        console.error(`[AUCTION_BID] [socket=${socket.id}] auction=${auctionId} participant=${participantId} unexpected error:`, err);
        socket.emit('bid:rejected', { reason: 'INTERNAL_ERROR' });
      }
    });

    // Without this, bidRateState grows by one entry per connection for the lifetime of the
    // process — every reconnect (and every dropped-then-reopened tab) leaks one more.
    socket.on('disconnect', () => {
      bidRateState.delete(socket.id);
      // Only clear the session slot if it still points at THIS socket — if a newer tab already
      // took over (and thus already overwrote the map entry with its own socket.id), this is the
      // old, just-evicted socket's own disconnect firing afterward, and it must not clobber the
      // new session that replaced it.
      if (activeSessionByParticipant.get(sessionKey) === socket.id) {
        activeSessionByParticipant.delete(sessionKey);
      }
    });
  });

  startCloseCheckLoop(io);
  return io;
}

function startCloseCheckLoop(io: SocketIOServer) {
  // A recursive setTimeout, not setInterval — the next tick is only scheduled once this one fully
  // finishes. With 20 concurrent auctions each needing several sequential DB calls to close, a
  // single tick can plausibly run past 500ms; setInterval would then start an overlapping tick
  // that still sees the not-yet-committed 'live' status and closes the same auction a second time
  // (double result summary, double auction:closed broadcast). This also means one auction's error
  // can't wedge every future tick — it's caught per-auction below, not just per-tick.
  async function tick() {
    try {
      const liveAuctions = await Auction.findAll({ where: { status: 'live' } });
      for (const auction of liveAuctions) {
        try {
          const state = await getAuctionState(auction.id);
          // A missing Redis state for a DB row that says 'live' means Redis lost the key (a
          // restart without persistence, eviction, etc.) — self-heal by reconstructing from the
          // DB's own mirrored fields (price, leader) and giving it a fresh window, rather than
          // leaving it permanently stuck with no automatic path to close. (windowEndsAt === null is
          // a separate, normal case: the brief moment between initAuctionState and startAuctionClock
          // at seed time — not a loss, so it's left alone rather than reconstructed.)
          if (!state) {
            console.warn(`[AUCTION_RECOVERY] auction=${auction.id} is 'live' in the DB but had no Redis state — reconstructing from last known price=${auction.currentLowestBid} leader=${auction.currentLeaderAlias ?? 'none'} with a fresh window.`);
            await reconstructAuctionState(auction);
            continue;
          }
          if (state.windowEndsAt === null) continue;
          if (Date.now() < state.windowEndsAt) continue;

          await markAuctionClosed(auction.id);
          await Auction.update(
            { status: 'closed', winnerParticipantId: state.leaderParticipantId },
            { where: { id: auction.id } }
          );
          await buildAndStoreResultSummary(auction.id, state.leaderParticipantId, state.leaderAlias, state.currentBid);
          io.to(`auction:${auction.id}`).emit('auction:closed', {
            winnerAlias: state.leaderAlias,
            winningBid: state.currentBid,
            resultType: RESULT_TYPE,
            disclosure: RESULT_DISCLOSURE,
          });
          releaseAuctionLock(auction.id);
        } catch (err) {
          console.error(`[AUCTION_CLOSE] auction=${auction.id} failed to close:`, err);
        }
      }
    } catch (err) {
      console.error('[AUCTION_CLOSE] close-check tick failed:', err);
    } finally {
      setTimeout(tick, CLOSE_CHECK_INTERVAL_MS);
    }
  }
  setTimeout(tick, CLOSE_CHECK_INTERVAL_MS);
}
