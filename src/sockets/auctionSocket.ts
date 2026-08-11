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

      // Every attempt is logged, including ones blocked before reaching the Redis compare-and-swap
      // — a rules-not-accepted or malformed-amount attempt is still a real audit-worthy event, not
      // just noise to discard (same principle as logging market-rejected bids).
      if (!socket.data.rulesAccepted) {
        await appendAuditedBid({
          auctionId,
          participantId,
          alias,
          amount: String(Number.isFinite(amount) ? amount : 0),
          accepted: false,
          rejectReason: 'RULES_NOT_ACCEPTED',
          ipHash,
        });
        socket.emit('bid:rejected', { reason: 'RULES_NOT_ACCEPTED' });
        return;
      }

      if (!Number.isFinite(amount)) {
        await appendAuditedBid({
          auctionId,
          participantId,
          alias,
          amount: '0',
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
    });
  });

  startCloseCheckLoop(io);
  return io;
}

function startCloseCheckLoop(io: SocketIOServer) {
  setInterval(async () => {
    const liveAuctions = await Auction.findAll({ where: { status: 'live' } });
    for (const auction of liveAuctions) {
      const state = await getAuctionState(auction.id);
      if (!state || state.windowEndsAt === null) continue;
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
    }
  }, CLOSE_CHECK_INTERVAL_MS);
}
