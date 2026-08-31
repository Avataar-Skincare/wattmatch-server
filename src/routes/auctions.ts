import { Router } from 'express';
import { jsonRateLimit as rateLimit } from '../lib/rateLimit.js';
import { Auction } from '../models/Auction.js';
import { AuctionParticipant } from '../models/AuctionParticipant.js';
import { signJoinToken, verifyJoinToken } from '../lib/auctionTokens.js';
import { verifyOrgToken } from '../lib/orgAuth.js';
import { decryptField } from '../lib/fieldEncryption.js';
import { authRequired, extractBearerToken } from '../middleware/auth.js';
import { logger } from '../lib/logger.js';

// Participant-facing auction routes — join and (post-close) winner-identity reveal. Distinct from
// auctionAdmin.ts, which is admin-only auction management (seed/export). Both routes here authenticate
// a real, logged-in Organization against a durable AuctionParticipant.organizationId membership row,
// not a bearer token embedded in an emailed link — see AuctionParticipant's own comment on why, and
// the design note in vettingAuctionBridge.ts's seedAuctionStandalone.

const router = Router();

// Real production join credential lives a few hours, not a day — nothing needs it to survive longer
// than a single sitting any more (see auctionTokens.ts's signJoinToken comment): a dropped connection
// mid-auction is handled by the frontend silently re-joining (AuctionLivePage.tsx), and returning
// after a longer gap just re-runs this same route from a still-or-newly-logged-in org session.
const JOIN_TOKEN_TTL = '4h';

const joinLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });
const mineLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const identityRevealLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many identity-reveal requests from this IP — try again shortly.' },
});

// The one independent, non-email-dependent way an org can discover an auction they're a real
// participant in — a fire-and-forget join-link email (vettingAuctionBridge.ts's promotion,
// auctionAdmin.ts's manual seed) silently failing previously meant an approved generator had no way
// to ever find out an auction they're entitled to bid in existed at all. Org-scoped by
// AuctionParticipant.organizationId, the same durable membership /join already authenticates
// against — legacy/manual-seed participants (organizationId: null) aren't listed here since they
// were never meant to discover this via a real org login in the first place (see AuctionParticipant's
// own comment).
router.get('/auctions/mine', mineLimiter, ...authRequired('generator', 'buyer'), async (req, res, next) => {
  try {
    const participants = await AuctionParticipant.findAll({ where: { organizationId: req.org!.id } });
    const auctions = await Auction.findAll({ where: { id: participants.map((p) => p.auctionId) } });
    const auctionById = new Map(auctions.map((a) => [a.id, a]));

    res.json({
      success: true,
      auctions: participants
        .map((p) => {
          const auction = auctionById.get(p.auctionId);
          if (!auction) return null;
          return {
            auctionId: auction.id,
            title: auction.title,
            status: auction.status,
            alias: p.alias,
            role: p.role,
            scheduledStartAt: auction.scheduledStartAt,
          };
        })
        .filter((a): a is NonNullable<typeof a> => a !== null),
    });
  } catch (err) {
    next(err);
  }
});

// Mints a fresh, short-lived socket credential for a real, org-backed participant — the org's own
// login (already re-validated by authRequired) is the actual gate; this token just carries the
// alias/participantId the live socket protocol needs, the same shape auctionAdmin.ts's legacy
// manual-seed path produces, so auctionSocket.ts needs no changes to accept either.
router.post('/auctions/:id/join', joinLimiter, ...authRequired('generator', 'buyer'), async (req, res, next) => {
  try {
    const auctionId = Number(req.params.id);
    if (!Number.isFinite(auctionId)) {
      return res.status(400).json({ success: false, error: 'Invalid auction id' });
    }

    const auction = await Auction.findByPk(auctionId);
    if (!auction) return res.status(404).json({ success: false, error: 'Auction not found' });

    // No auction-status gating here — a caller can join whether it's scheduled, live, or already
    // closed (auctionSocket.ts already replays synced state and, for a closed auction, the result
    // event to a late-connecting socket, so there's no reason to block the join itself).
    const participant = await AuctionParticipant.findOne({
      where: { auctionId, organizationId: req.org!.id },
    });
    if (!participant) {
      return res.status(403).json({ success: false, error: 'You are not invited to this auction' });
    }

    const token = await signJoinToken(
      { auctionId, participantId: participant.id, alias: participant.alias, jti: participant.joinTokenId },
      JOIN_TOKEN_TTL
    );

    logger.info(
      { reqId: req.requestId, auctionId, organizationId: req.org!.id, participantId: participant.id },
      '[AUCTION_JOIN] joined'
    );

    res.json({ success: true, token, alias: participant.alias, role: participant.role, auctionId });
  } catch (err) {
    next(err);
  }
});

// Tries the token as an org session first (the production path — see /join above); a legacy
// manual-seed participant (auctionAdmin.ts's /auctions/seed, AuctionParticipant.organizationId ===
// null) has no org to log in as, so falls back to validating it as their original auction join
// token instead. The two token types are signed with different secrets (ORG_JWT_SECRET vs.
// AUCTION_JWT_SECRET), so a token failing verifyOrgToken because it's actually the other kind is
// the expected, silent case here, not an error worth logging.
async function resolveOrgParticipant(auctionId: number, token: string): Promise<AuctionParticipant | null> {
  try {
    const orgPayload = await verifyOrgToken(token);
    return await AuctionParticipant.findOne({ where: { auctionId, organizationId: orgPayload.organizationId } });
  } catch {
    return null;
  }
}

async function resolveLegacyParticipant(auctionId: number, token: string): Promise<AuctionParticipant | null> {
  try {
    const payload = await verifyJoinToken(token);
    if (payload.auctionId !== auctionId) return null;
    // organizationId: null scopes this fallback to legacy/manual-seed participants only — an
    // org-backed participant must prove themselves via their org login, not a stray join token.
    return await AuctionParticipant.findOne({
      where: { id: payload.participantId, auctionId, joinTokenId: payload.jti, organizationId: null },
    });
  } catch {
    return null;
  }
}

// Winning-pair identity reveal (see LIVE_AUCTION_IDENTITY_ENCRYPTION_PLAN.md's "follow-up" and
// BID_SEALING_BUILD_CHECKLIST.md's C.5: "Auto-reveal of identity for the winning pair only, on
// auction close. Losing bidders' identities remain sealed post-auction."). This is the one
// legitimate reason organizationName ever needs to be decrypted: the buyer needs the winning
// generator's real company to execute a PPA, and the winner needs to know who they're contracting
// with. Everyone else — losing generators, anyone without valid credentials at all — gets nothing.
router.get('/auctions/:id/winner-identity', identityRevealLimiter, async (req, res, next) => {
  try {
    const auctionId = Number(req.params.id);
    if (!Number.isFinite(auctionId)) {
      return res.status(400).json({ success: false, error: 'Invalid auction id' });
    }

    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      return res.status(401).json({ success: false, error: 'Missing credentials' });
    }

    const requester = (await resolveOrgParticipant(auctionId, token)) ?? (await resolveLegacyParticipant(auctionId, token));
    if (!requester) {
      logger.warn({ reqId: req.requestId, auctionId }, '[AUCTION_IDENTITY] rejected: invalid or unrecognized credentials');
      return res.status(401).json({ success: false, error: 'Invalid or expired credentials for this auction' });
    }

    const auction = await Auction.findByPk(auctionId);
    if (!auction) return res.status(404).json({ success: false, error: 'Auction not found' });
    // Checked before branching on winner/buyer so a losing generator can't use timing/error-shape
    // differences to learn anything about the auction's outcome before it's actually final.
    if (auction.status !== 'closed') {
      return res.status(409).json({ success: false, error: 'Identity reveal is only available after the auction closes' });
    }
    if (!auction.winnerParticipantId) {
      return res.status(404).json({ success: false, error: 'This auction closed with no winner' });
    }

    const isWinner = requester.id === auction.winnerParticipantId;
    const isBuyer = requester.role === 'buyer';
    if (!isWinner && !isBuyer) {
      logger.warn(
        { reqId: req.requestId, auctionId, requesterParticipantId: requester.id, requesterRole: requester.role },
        '[AUCTION_IDENTITY] rejected: requester is neither the winner nor the buyer'
      );
      return res.status(403).json({ success: false, error: 'Only the winning generator and the buyer can reveal identity for this auction' });
    }

    const counterparty = isWinner
      ? await AuctionParticipant.findOne({ where: { auctionId, role: 'buyer' } })
      : await AuctionParticipant.findOne({ where: { id: auction.winnerParticipantId } });
    if (!counterparty) {
      // A generator-only auction (no buyer seat) has nothing for the winner to reveal — not an
      // error in the auction itself, just nothing to return here.
      return res.status(404).json({ success: false, error: 'No counterparty to reveal (this auction had no buyer seat)' });
    }

    const organizationName = await decryptField(counterparty.organizationName);

    // Privileged-action logging — this is the one route that ever turns encrypted identity back
    // into plaintext, so every call is worth a permanent trace of exactly who saw whose identity.
    logger.info(
      {
        reqId: req.requestId,
        auctionId,
        requesterParticipantId: requester.id,
        requesterRole: requester.role,
        revealedParticipantId: counterparty.id,
      },
      '[AUCTION_IDENTITY] winning-pair identity revealed'
    );

    res.json({ success: true, alias: counterparty.alias, organizationName });
  } catch (err) {
    next(err);
  }
});

export default router;
