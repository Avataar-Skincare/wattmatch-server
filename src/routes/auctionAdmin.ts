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
router.post('/auctions/seed', async (req, res, next) => {
  // Express 4 does not catch a rejected promise from an async handler on its own — without this,
  // any DB error below (bad input that still passes the checks, a constraint violation, a
  // transient connection blip) becomes an unhandled rejection and crashes the whole process,
  // taking down every other live auction with it. next(err) hands it to the error middleware in
  // index.ts instead, which logs it and returns a clean 500.
  try {
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

    // `!openingBid` would also be true for a legitimate 0 (falsy) — checked as a type/range test
    // instead so an actual ₹0 opening bid (nonsensical, but not what this check is meant to catch)
    // doesn't get rejected with a misleading "required" error. windowSeconds/maxAutoExtensions get
    // the same treatment: both are INTEGER.UNSIGNED columns, so a non-numeric or negative value
    // (the request body is only type-asserted, not runtime-validated, so nothing stops a caller
    // from sending a string) would otherwise throw on the Auction.create() insert below instead of
    // being rejected cleanly here.
    if (
      !title ||
      typeof openingBid !== 'number' ||
      openingBid <= 0 ||
      typeof windowSeconds !== 'number' ||
      windowSeconds <= 0 ||
      typeof maxAutoExtensions !== 'number' ||
      maxAutoExtensions < 0 ||
      !Array.isArray(participants) ||
      participants.length === 0
    ) {
      return res.status(400).json({
        success: false,
        error: 'title, a positive openingBid, a positive windowSeconds, a non-negative maxAutoExtensions, and at least one participant are required',
      });
    }

    // The whole live protocol identifies bidders by alias only (leaderAlias, feed lines) — a
    // duplicate alias within one auction would make it impossible for participants to tell who's
    // actually leading. Checked before anything is created, so a bad request doesn't leave a
    // half-seeded auction behind.
    const aliases = participants.map((p) => p.alias);
    if (new Set(aliases).size !== aliases.length) {
      return res.status(400).json({ success: false, error: 'Participant aliases must be unique within an auction' });
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

    // Falls back to localhost silently — fine for local dev, but if CORS_ORIGIN is ever missed in
    // a real deployment this would still return 200 OK with join links that look valid but point
    // nowhere for real users. Warning loudly (same pattern as auctionTokens.ts's JWT secret check)
    // so it's at least visible in the server logs rather than a mystery bug report later.
    if (!process.env.CORS_ORIGIN) {
      console.warn('[AUCTION_ADMIN] CORS_ORIGIN is not set — generated join links point at localhost, not a real deployment URL.');
    }
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
  } catch (err) {
    next(err);
  }
});

// Evidence-export control: lets a customer or auditor pull the full, verifiable record for a
// closed (or in-progress) auction — the hash-chained bid log plus the signed result summary.
// No auth, same as the rest of this file — not something to expose on the real platform as-is.
router.get('/auctions/:id/export', async (req, res, next) => {
  try {
    const auctionId = Number(req.params.id);
    // A non-numeric :id (e.g. /auctions/abc/export) makes this NaN — reject before it reaches a
    // query, since some DB drivers throw on a NaN bind parameter rather than just matching nothing.
    if (!Number.isFinite(auctionId)) {
      return res.status(400).json({ success: false, error: 'Invalid auction id' });
    }
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
  } catch (err) {
    next(err);
  }
});

export default router;
