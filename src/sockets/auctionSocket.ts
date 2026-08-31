import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { RateLimiterRedis, type RateLimiterRes } from 'rate-limiter-flexible';
import type { Server as HTTPServer } from 'node:http';
import { verifyJoinToken, hashIp, type AuctionTokenPayload } from '../lib/auctionTokens.js';
import { redis } from '../lib/redis.js';
import { AuctionParticipant, type AuctionParticipantRole } from '../models/AuctionParticipant.js';
import { Auction } from '../models/Auction.js';
import { logger } from '../lib/logger.js';
import {
  getAuctionState,
  submitBid,
  markAuctionClosed,
  appendAuditedBid,
  buildAndStoreResultSummary,
  reconstructAuctionState,
  RESULT_TYPE,
  RESULT_DISCLOSURE,
  MAX_BID_AMOUNT,
  sanitizeAmountForAudit,
  sanitizePercentForAudit,
} from '../services/auctionEngine.js';

// Single recurring poll, not a per-bid setTimeout reschedule — avoids Node event-loop-lag drift
// under bursty bidding. See AUCTION_MVP_PLAN.md.
const CLOSE_CHECK_INTERVAL_MS = 500;

// Redis-backed rate limiting (rate-limiter-flexible), not hand-rolled in-memory Maps — this was
// previously two process-local counters, which meant the limit only worked correctly on a single
// server instance (the same limitation already documented on the write lock below). Backing them
// with Redis, which this app already depends on for everything else, makes both limits correct
// across multiple instances for free, and TTL-based key expiry means neither needs manual cleanup
// on disconnect or auction close the way the old Maps did.
//
// Per-socket: bounds bursts within one connection. Per-participant: survives a reconnect (keyed by
// "auctionId:participantId", not socket.id), specifically closing the gap where someone could
// disconnect and reconnect every few bids to dodge the per-socket limit — a fresh socket.id resets
// that one, but not this one. Deliberately more generous so a normal reconnect never trips it.
const bidRateLimiterBySocket = new RateLimiterRedis({ storeClient: redis, keyPrefix: 'auction_bidlimit_socket', points: 5, duration: 2 });
const bidRateLimiterByParticipant = new RateLimiterRedis({ storeClient: redis, keyPrefix: 'auction_bidlimit_participant', points: 15, duration: 5 });

// `.consume()` resolves under the limit and rejects over it — rejecting with a RateLimiterRes
// (not a plain Error) is how the library signals "blocked," as opposed to an actual failure (e.g.
// Redis unreachable), which rejects with a real Error and should be treated as the same kind of
// failure the rest of the bid path already has if Redis is down, not silently swallowed as "fine."
async function isRateLimited(limiter: RateLimiterRedis, key: string): Promise<boolean> {
  try {
    await limiter.consume(key);
    return false;
  } catch (err) {
    if (err instanceof Error) throw err;
    return true;
  }
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
    { 'bid:new': (payload: { rate: number; returnPercent: number }) => void; 'rules:accept': () => void },
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
  // makes broadcast fan-out correct across instances. Bid acceptance itself is already
  // multi-instance-safe (auctionEngine.ts's hash-chain write is a DB unique-constraint-plus-retry,
  // not a process-local lock — see its own comment). The one piece of this file that is still
  // process-local is `activeSessionByParticipant` below: on more than one instance, a participant's
  // "take over the old session" check only sees sessions on the same instance they're connecting
  // to, so a reconnect landing on a different instance than their old session wouldn't disconnect
  // it. Not reachable yet — this PoC runs a single instance — but would need a Redis-backed session
  // map (same pattern as the rate limiters below) before it could scale beyond one.
  const pubClient = redis.duplicate();
  const subClient = pubClient.duplicate();
  pubClient.on('error', (err: Error) => logger.error({ err }, 'Redis adapter pubClient error'));
  subClient.on('error', (err: Error) => logger.error({ err }, 'Redis adapter subClient error'));
  io.adapter(createAdapter(pubClient, subClient));

  // Identity is resolved ONCE at handshake, from the verified token, and bound to socket.data.
  // Never trust an id/alias arriving inside a later event payload — see AUCTION_PLAN.md's
  // real-time transport section on why (spoofing risk).
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) {
      logger.warn({ socketId: socket.id, ip: socket.handshake.address }, '[AUCTION_AUTH] rejected: missing join token');
      return next(new Error('Missing join token'));
    }

    // Split from the DB lookup below on purpose — a bad/expired JWT and a database hiccup are
    // different failure modes with different fixes, and lumping them into one catch-all made every
    // DB blip during auth look like "invalid or expired token" in the logs, which sends debugging
    // down the wrong path entirely.
    let payload: AuctionTokenPayload;
    try {
      payload = await verifyJoinToken(token);
    } catch (err) {
      logger.warn({ socketId: socket.id, ip: socket.handshake.address, err }, '[AUCTION_AUTH] rejected: invalid/expired token');
      return next(new Error('Invalid or expired join token'));
    }

    try {
      const participant = await AuctionParticipant.findOne({
        where: { id: payload.participantId, auctionId: payload.auctionId, joinTokenId: payload.jti },
      });
      if (!participant) {
        logger.warn(
          { socketId: socket.id, auctionId: payload.auctionId, participantId: payload.participantId, ip: socket.handshake.address },
          '[AUCTION_AUTH] rejected: unknown/revoked token'
        );
        return next(new Error('Unknown or revoked join token'));
      }
      socket.data.auctionId = payload.auctionId;
      socket.data.participantId = payload.participantId;
      socket.data.alias = payload.alias;
      socket.data.role = participant.role;
      socket.data.rulesAccepted = participant.rulesAcceptedAt !== null;
      next();
    } catch (err) {
      logger.error(
        { socketId: socket.id, auctionId: payload.auctionId, ip: socket.handshake.address, err },
        '[AUCTION_AUTH] internal error looking up participant'
      );
      next(new Error('Internal error — try again'));
    }
  });

  io.on('connection', async (socket) => {
    const { auctionId, participantId } = socket.data;
    const room = `auction:${auctionId}`;
    const sessionKey = sessionKeyFor(auctionId, participantId);

    // Everything below can throw (Redis, the session-takeover broadcast, room join) — without this,
    // an unhandled rejection here crashes the whole process (Node terminates on unhandled rejection
    // by default, and there's no global handler), taking down every other live auction along with
    // it, not just this one connection. Same reasoning already applied to rules:accept/bid:new below.
    try {
      // Take over any existing session for this same participant before doing anything else — the
      // old tab/device is told why it's being cut off, then force-disconnected. Using io.to/io.in
      // (not a local socket lookup) so this still works if the old socket happens to be connected to
      // a different server instance behind the Redis adapter.
      const previousSocketId = activeSessionByParticipant.get(sessionKey);
      if (previousSocketId && previousSocketId !== socket.id) {
        logger.info(
          { auctionId, participantId, alias: socket.data.alias, oldSocketId: previousSocketId, newSocketId: socket.id },
          '[AUCTION_SESSION] session replaced'
        );
        io.to(previousSocketId).emit('session:replaced');
        io.in(previousSocketId).disconnectSockets(true);
      }
      activeSessionByParticipant.set(sessionKey, socket.id);

      // Tagged with the stable identity (participant/alias), not just the ephemeral socket.id, so a
      // log search for one participant shows every connect/disconnect across however many times they
      // reconnected — the socket.id is a new random value every time and useless for that on its own.
      logger.info(
        { socketId: socket.id, auctionId, participantId, alias: socket.data.alias, role: socket.data.role, ip: socket.handshake.address },
        '[AUCTION_SESSION] connected'
      );

      await socket.join(room);

      // On connect or reconnect, push current state from Redis — the source of truth, so a
      // dropped-and-reconnected client just re-syncs with no special-case logic.
      const state = await getAuctionState(auctionId);
      socket.emit('state:sync', state);
      socket.emit('you:info', { alias: socket.data.alias, role: socket.data.role, rulesAccepted: socket.data.rulesAccepted });

      // A (re)join after the auction already closed would otherwise never see the winner summary —
      // the real 'auction:closed' broadcast is a one-time event sent only to whoever was connected at
      // the exact moment it fired. Replaying it privately to just this socket reuses the client's
      // existing handler as-is (no frontend change needed) instead of leaving a late joiner stuck
      // looking at a "closed" status with no result shown.
      if (state?.status === 'closed') {
        socket.emit('auction:closed', {
          winnerAlias: state.leaderAlias,
          winningBid: state.currentBid,
          resultType: RESULT_TYPE,
          disclosure: RESULT_DISCLOSURE,
        });
      }
    } catch (err) {
      logger.error({ socketId: socket.id, auctionId, participantId, err }, '[AUCTION_SESSION] failed to complete connection setup');
      return;
    }

    // Participant acknowledgement control: bidding is gated on this, not just a UI formality —
    // see the "Dispute and customer controls" checklist in REGULATORY_CERTIFICATION_RESEARCH.md.
    socket.on('rules:accept', async () => {
      if (socket.data.rulesAccepted) return;
      // Without this try/catch, a transient DB error here (this is a plain write, same as any
      // other) would be an unhandled rejection in an async socket handler — crashing the whole
      // process and every other live auction with it, exactly the failure mode already guarded
      // against in bid:new. The client just sees the rules box stay up and can retry the click.
      try {
        await AuctionParticipant.update(
          { rulesAcceptedAt: new Date() },
          { where: { id: socket.data.participantId } }
        );
        socket.data.rulesAccepted = true;
        socket.emit('rules:accepted');
      } catch (err) {
        logger.error({ socketId: socket.id, participantId: socket.data.participantId, err }, '[AUCTION_RULES] failed to record rules acceptance');
      }
    });

    socket.on('bid:new', async (payload) => {
      const { auctionId, participantId, alias } = socket.data;
      const rate = Number(payload?.rate);
      const returnPercent = Number(payload?.returnPercent);
      const ipHash = await hashIp(socket.handshake.address);

      // Everything below can throw (a DB write, Redis) — without this, an unhandled rejection in
      // an async socket handler crashes the whole process (Node terminates on unhandled rejection
      // by default), taking down every other live auction along with it, not just this one bid.
      try {
        // A buyer's join link is a read-only spectator seat (see AuctionParticipant's role field) —
        // the UI never shows them a bid form, so reaching this at all means either a bug or someone
        // hand-crafting socket events. Not audit-logged as a market event (it isn't one); a console
        // line is enough to notice.
        if (socket.data.role !== 'generator') {
          logger.warn({ socketId: socket.id, auctionId, participantId, role: socket.data.role }, '[AUCTION_BID] rejected: not a bidder');
          socket.emit('bid:rejected', { reason: 'NOT_A_BIDDER' });
          return;
        }

        // Checked first and deliberately NOT audit-logged like the other rejections below — logging
        // every over-limit attempt would itself be the DB-write amplification this limit exists to
        // prevent. A console line is enough to notice abuse without writing it to the audit trail.
        // Two separate checks: per-socket (bursts within one connection) and per-participant
        // (survives a reconnect, so disconnecting-and-reconnecting to dodge the per-socket limit
        // doesn't actually reset anything).
        if ((await isRateLimited(bidRateLimiterBySocket, socket.id)) || (await isRateLimited(bidRateLimiterByParticipant, sessionKey))) {
          logger.warn({ socketId: socket.id, auctionId, participantId }, '[AUCTION_BID] rate-limited');
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
            amount: sanitizeAmountForAudit(rate),
            rate: sanitizeAmountForAudit(rate),
            returnPercent: sanitizePercentForAudit(returnPercent),
            accepted: false,
            rejectReason: 'RULES_NOT_ACCEPTED',
            ipHash,
          });
          socket.emit('bid:rejected', { reason: 'RULES_NOT_ACCEPTED' });
          return;
        }

        // Same reasoning as before this change, applied to both raw inputs now instead of just one:
        // with no floor/ceiling here, an invalid rate or an out-of-range return% would otherwise
        // either be silently accepted or throw on the DB insert below instead of being caught here
        // cleanly.
        if (!Number.isFinite(rate) || rate <= 0 || rate > MAX_BID_AMOUNT) {
          await appendAuditedBid({
            auctionId,
            participantId,
            alias,
            amount: sanitizeAmountForAudit(rate),
            rate: sanitizeAmountForAudit(rate),
            returnPercent: sanitizePercentForAudit(returnPercent),
            accepted: false,
            rejectReason: 'INVALID_AMOUNT',
            ipHash,
          });
          socket.emit('bid:rejected', { reason: 'INVALID_AMOUNT' });
          return;
        }
        if (!Number.isFinite(returnPercent) || returnPercent < 0 || returnPercent > 100) {
          await appendAuditedBid({
            auctionId,
            participantId,
            alias,
            amount: sanitizeAmountForAudit(rate),
            rate: sanitizeAmountForAudit(rate),
            returnPercent: sanitizePercentForAudit(returnPercent),
            accepted: false,
            rejectReason: 'INVALID_RETURN_PERCENT',
            ipHash,
          });
          socket.emit('bid:rejected', { reason: 'INVALID_RETURN_PERCENT' });
          return;
        }

        const result = await submitBid(auctionId, rate, returnPercent, participantId, alias);

        await appendAuditedBid({
          auctionId,
          participantId,
          alias,
          amount: String(result.landedRate),
          rate: String(rate),
          returnPercent: String(returnPercent),
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
        logger.error({ socketId: socket.id, auctionId, participantId, err }, '[AUCTION_BID] unexpected error');
        socket.emit('bid:rejected', { reason: 'INTERNAL_ERROR' });
      }
    });

    socket.on('disconnect', (reason) => {
      // Same stable-identity tagging as the connect log above — pairing every "connected" line
      // with its matching "disconnected" line (by participant/alias, not the one-off socket.id)
      // is what makes a reconnect actually traceable as the same person across the log, rather
      // than looking like two unrelated strangers who each showed up once.
      logger.info(
        { socketId: socket.id, auctionId, participantId, alias: socket.data.alias, reason },
        '[AUCTION_SESSION] disconnected'
      );
      // The rate-limit counters no longer need manual cleanup here — they're Redis-backed with
      // their own TTLs now, unlike the old in-memory Maps this replaced.
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
            logger.warn(
              { auctionId: auction.id, lastKnownPrice: auction.currentLowestBid, lastKnownLeader: auction.currentLeaderAlias ?? 'none' },
              "[AUCTION_RECOVERY] auction is 'live' in the DB but had no Redis state — reconstructing with a fresh window"
            );
            await reconstructAuctionState(auction);
            continue;
          }
          if (state.windowEndsAt === null) continue;
          if (Date.now() < state.windowEndsAt) continue;

          await markAuctionClosed(auction.id);
          await Auction.update(
            // currentExtensionCount was otherwise never written anywhere — every closed auction's
            // DB row permanently showed 0 extensions used regardless of what actually happened,
            // since only Redis tracked the real count during the live phase. Mirroring it here
            // means the historical record (and buildAndStoreResultSummary below, which reads this
            // same row) reflects reality instead of a stale default.
            { status: 'closed', winnerParticipantId: state.leaderParticipantId, currentExtensionCount: state.extensionCount },
            { where: { id: auction.id } }
          );
          await buildAndStoreResultSummary(auction.id, state.leaderParticipantId, state.leaderAlias, state.currentBid);
          // EMD is a physical Bank Guarantee now, not money (see EmdSubmission) — there is no
          // automatic release on auction close any more. Admin sees every approved generator's EMD
          // status in the EMD console (emdSubmissions.ts) and releases/invokes each manually, since
          // returning a document is a real-world action this socket handler can't perform.
          io.to(`auction:${auction.id}`).emit('auction:closed', {
            winnerAlias: state.leaderAlias,
            winningBid: state.currentBid,
            resultType: RESULT_TYPE,
            disclosure: RESULT_DISCLOSURE,
          });
          // No explicit lock cleanup needed at close anymore — the DB-level advisory lock in
          // auctionEngine.ts is acquired and released within each individual write, not held
          // across a shared, growing in-memory structure the way the old lock was.
          // Every other significant lifecycle event (seed, export, connect/disconnect, session
          // takeover, recovery) logs a line — a successful close was the one silent exception,
          // with nothing in the operational log unless something went wrong. The DB result summary
          // is the durable record, but "did auction X actually close, and when" shouldn't require
          // querying the database just to confirm nothing broke.
          logger.info(
            { auctionId: auction.id, winnerAlias: state.leaderAlias ?? 'none', winnerParticipantId: state.leaderParticipantId ?? 'none', winningBid: state.currentBid },
            '[AUCTION_CLOSE] closed'
          );
        } catch (err) {
          logger.error({ auctionId: auction.id, err }, '[AUCTION_CLOSE] failed to close');
        }
      }
    } catch (err) {
      logger.error({ err }, '[AUCTION_CLOSE] close-check tick failed');
    } finally {
      setTimeout(tick, CLOSE_CHECK_INTERVAL_MS);
    }
  }
  setTimeout(tick, CLOSE_CHECK_INTERVAL_MS);
}
