import { Server as SocketIOServer } from 'socket.io';
import type { Server as HTTPServer } from 'node:http';
import { verifyJoinToken, hashIp } from '../lib/auctionTokens.js';
import { AuctionParticipant } from '../models/AuctionParticipant.js';
import { Auction } from '../models/Auction.js';
import {
  getAuctionState,
  submitBid,
  markAuctionClosed,
  appendAuditedBid,
  buildAndStoreResultSummary,
  releaseAuctionLock,
  RESULT_TYPE,
  RESULT_DISCLOSURE,
  MAX_BID_AMOUNT,
  sanitizeAmountForAudit,
} from '../services/auctionEngine.js';

// Single recurring poll, not a per-bid setTimeout reschedule — avoids Node event-loop-lag drift
// under bursty bidding. See AUCTION_MVP_PLAN.md.
const CLOSE_CHECK_INTERVAL_MS = 500;

interface AuctionSocketData {
  auctionId: number;
  participantId: number;
  alias: string;
  rulesAccepted: boolean;
}

export function setupAuctionSocket(httpServer: HTTPServer) {
  const io = new SocketIOServer<
    { 'bid:new': (payload: { amount: number }) => void; 'rules:accept': () => void },
    {
      'state:sync': (state: unknown) => void;
      'you:info': (payload: { alias: string; rulesAccepted: boolean }) => void;
      'rules:accepted': () => void;
      'state:update': (payload: { currentBid: number; windowEndsAt: number; alias: string }) => void;
      'bid:rejected': (payload: { reason: string; currentBid?: number }) => void;
      'auction:closed': (payload: {
        winnerAlias: string | null;
        winningBid: number;
        resultType: string;
        disclosure: string;
      }) => void;
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

  // Identity is resolved ONCE at handshake, from the verified token, and bound to socket.data.
  // Never trust an id/alias arriving inside a later event payload — see AUCTION_PLAN.md's
  // real-time transport section on why (spoofing risk).
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      if (!token) return next(new Error('Missing join token'));
      const payload = verifyJoinToken(token);
      const participant = await AuctionParticipant.findOne({
        where: { id: payload.participantId, auctionId: payload.auctionId, joinTokenId: payload.jti },
      });
      if (!participant) return next(new Error('Unknown or revoked join token'));
      socket.data.auctionId = payload.auctionId;
      socket.data.participantId = payload.participantId;
      socket.data.alias = payload.alias;
      socket.data.rulesAccepted = participant.rulesAcceptedAt !== null;
      next();
    } catch {
      next(new Error('Invalid or expired join token'));
    }
  });

  io.on('connection', async (socket) => {
    const { auctionId } = socket.data;
    const room = `auction:${auctionId}`;
    await socket.join(room);

    // On connect or reconnect, push current state from Redis — the source of truth, so a
    // dropped-and-reconnected client just re-syncs with no special-case logic.
    const state = await getAuctionState(auctionId);
    socket.emit('state:sync', state);
    socket.emit('you:info', { alias: socket.data.alias, rulesAccepted: socket.data.rulesAccepted });

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
          await Auction.update({ currentLowestBid: String(result.currentBid) }, { where: { id: auctionId } });
          io.to(room).emit('state:update', {
            currentBid: result.currentBid,
            windowEndsAt: result.windowEndsAt,
            alias,
          });
        } else {
          socket.emit('bid:rejected', { reason: result.reason, currentBid: result.currentBid });
        }
      } catch (err) {
        console.error(`[AUCTION_BID] auction=${auctionId} participant=${participantId} unexpected error:`, err);
        socket.emit('bid:rejected', { reason: 'INTERNAL_ERROR' });
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
          // restart without persistence, eviction, etc.) — without this log line, such an auction
          // would just silently sit 'live' forever with no way to close, since nothing else here
          // treats that as unusual. (windowEndsAt === null is a separate, normal case: the brief
          // moment between initAuctionState and startAuctionClock at seed time.)
          if (!state) {
            console.error(`[AUCTION_CLOSE] auction=${auction.id} is 'live' in the DB but has no Redis state — stuck, cannot close automatically.`);
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
