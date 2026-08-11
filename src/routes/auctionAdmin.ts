import { Router } from 'express';
import { Auction } from '../models/Auction.js';
import { AuctionParticipant } from '../models/AuctionParticipant.js';
import { AuctionBid } from '../models/AuctionBid.js';
import { generateJti, signJoinToken } from '../lib/auctionTokens.js';
import { initAuctionState, startAuctionClock, MIN_UNDERCUT } from '../services/auctionEngine.js';

const router = Router();

// PoC-only seed endpoint — stands in for the real enrollment flow (which will source eligible
// generators from the matching engine in MARKETPLACE_PLAN.md). No auth, matches this project's
// existing authless-admin-route pattern; not something to expose on the real platform.
router.post('/auctions/seed', async (req, res) => {
  const {
    title,
    openingBid,
    windowSeconds = 480,
    maxAutoExtensions = 8,
    participants,
  } = req.body as {
    title?: string;
    openingBid?: number;
    windowSeconds?: number;
    maxAutoExtensions?: number;
    participants?: { organizationName: string; alias: string }[];
  };

  if (!title || !openingBid || !Array.isArray(participants) || participants.length === 0) {
    return res.status(400).json({ success: false, error: 'title, openingBid, and at least one participant are required' });
  }

  // minUndercut is intentionally NOT accepted from the request body — it's a flat platform rule
  // (AUCTION_PLAN.md), not something a seed caller gets to configure per auction. Snapshotting the
  // current constant here is purely for rule-version tracking (see Auction.minUndercut's comment).
  const auction = await Auction.create({
    title,
    status: 'live',
    openingBid: String(openingBid),
    currentLowestBid: String(openingBid),
    windowSeconds,
    maxAutoExtensions,
    minUndercut: String(MIN_UNDERCUT),
  });

  await initAuctionState(auction.id, openingBid, windowSeconds, maxAutoExtensions, MIN_UNDERCUT);
  const windowEndsAt = await startAuctionClock(auction.id, windowSeconds);

  const frontendOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:5173';
  const links = [];
  for (const p of participants) {
    const jti = generateJti();
    const participant = await AuctionParticipant.create({
      auctionId: auction.id,
      organizationName: p.organizationName,
      alias: p.alias,
      joinTokenId: jti,
    });
    const token = signJoinToken({ auctionId: auction.id, participantId: participant.id, alias: p.alias, jti });
    links.push({
      alias: p.alias,
      organizationName: p.organizationName,
      joinUrl: `${frontendOrigin}/auction-live?token=${encodeURIComponent(token)}`,
    });
  }

  // Privileged-action logging: this route creates real auction state with no auth in front of
  // it, so at minimum every call should leave a trace of who/when/what — see the "Identity,
  // authentication and access" checklist. Full RBAC/audit trail is deferred, but this is cheap.
  console.log(
    `[AUCTION_ADMIN] seed: auctionId=${auction.id} title="${title}" participants=${participants.length} ip=${req.ip} at=${new Date().toISOString()}`
  );

  res.json({ success: true, auctionId: auction.id, windowEndsAt, links });
});

// Evidence-export control: lets a customer or auditor pull the full, verifiable record for a
// closed (or in-progress) auction — the hash-chained bid log plus the signed result summary.
// No auth, same as the rest of this file — not something to expose on the real platform as-is.
router.get('/auctions/:id/export', async (req, res) => {
  const auctionId = Number(req.params.id);
  const auction = await Auction.findByPk(auctionId);
  if (!auction) return res.status(404).json({ success: false, error: 'Auction not found' });

  const participants = await AuctionParticipant.findAll({
    where: { auctionId },
    attributes: ['id', 'alias', 'organizationName', 'rulesAcceptedAt', 'createdAt'],
  });
  const bids = await AuctionBid.findAll({
    where: { auctionId },
    order: [['id', 'ASC']],
    attributes: ['id', 'alias', 'amount', 'accepted', 'rejectReason', 'ipHash', 'prevHash', 'hash', 'createdAt'],
  });

  res.json({
    success: true,
    auction: {
      id: auction.id,
      title: auction.title,
      status: auction.status,
      openingBid: auction.openingBid,
      currentLowestBid: auction.currentLowestBid,
      minUndercut: auction.minUndercut,
      winnerParticipantId: auction.winnerParticipantId,
      resultSummary: auction.resultSummaryJson ? JSON.parse(auction.resultSummaryJson) : null,
      resultHash: auction.resultHash,
    },
    participants,
    bids,
  });
});

export default router;
