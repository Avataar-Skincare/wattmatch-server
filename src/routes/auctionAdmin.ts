import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { Auction } from '../models/Auction.js';
import { AuctionParticipant } from '../models/AuctionParticipant.js';
import { AuctionBid } from '../models/AuctionBid.js';
import { generateJti, signJoinToken } from '../lib/auctionTokens.js';
import { initAuctionState, startAuctionClock, MIN_UNDERCUT } from '../services/auctionEngine.js';

const router = Router();

// These routes have no auth in front of them (see each route's own comment) — rate limiting is
// the one cheap thing that bounds how much damage that allows: it can't stop a determined caller,
// but it stops both routes from being trivially scriptable into a bulk-create or bulk-scrape tool.
// Keyed on IP by default (express-rate-limit's standard keyGenerator), which is enough for a PoC
// with no real user identity to key on yet. NOTE: this keys on req.ip, which resolves correctly
// on localhost today but will bucket every caller under one shared IP once this sits behind
// CloudFront/an ALB in production — at that point `app.set('trust proxy', ...)` needs to be set to
// the real hop count so req.ip reads the client's actual IP from X-Forwarded-For instead of the
// proxy's. Not set now because guessing the wrong hop count would let a caller spoof their way
// around the limit, which is worse than the limit being coarse in the meantime.
const seedLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many auctions created from this IP — try again later.' },
});
const exportLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many export requests from this IP — try again shortly.' },
});

// PoC-only seed endpoint — stands in for the real enrollment flow (which will source eligible
// generators from the matching engine in MARKETPLACE_PLAN.md). No auth, matches this project's
// existing authless-admin-route pattern; not something to expose on the real platform.
router.post('/auctions/seed', seedLimiter, async (req, res, next) => {
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
      buyer,
    } = req.body as {
      title?: string;
      openingBid?: number;
      windowSeconds?: number;
      maxAutoExtensions?: number;
      participants?: { organizationName: string; alias: string }[];
      // Optional — a real listing always has one, but plenty of PoC/demo runs don't need a
      // spectator seat at all, so this isn't required. A buyer is otherwise seated exactly like a
      // generator (same join-token mechanism, same alias-only exposure) except never allowed to
      // bid — see auctionSocket.ts's role check.
      buyer?: { organizationName: string; alias: string };
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
      participants.length === 0 ||
      (buyer !== undefined && (typeof buyer.organizationName !== 'string' || typeof buyer.alias !== 'string' || !buyer.alias))
    ) {
      return res.status(400).json({
        success: false,
        error: 'title, a positive openingBid, a positive windowSeconds, a non-negative maxAutoExtensions, at least one participant, and (if present) a valid buyer are required',
      });
    }

    // The whole live protocol identifies bidders by alias only (leaderAlias, feed lines) — a
    // duplicate alias within one auction would make it impossible to tell who's actually leading,
    // or would let the buyer's own alias collide with a generator's. Checked before anything is
    // created, so a bad request doesn't leave a half-seeded auction behind.
    const aliases = participants.map((p) => p.alias).concat(buyer ? [buyer.alias] : []);
    if (new Set(aliases).size !== aliases.length) {
      return res.status(400).json({ success: false, error: 'Participant (and buyer) aliases must be unique within an auction' });
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
        role: 'generator',
        joinTokenId: jti,
      });
      const token = signJoinToken({ auctionId: auction.id, participantId: participant.id, alias: p.alias, jti });
      links.push({
        alias: p.alias,
        organizationName: p.organizationName,
        joinUrl: `${frontendOrigin}/auction-live?token=${encodeURIComponent(token)}`,
      });
    }

    // Buyer is optional and gets a role='buyer' seat: same join-token mechanism as a generator,
    // but auctionSocket.ts's bid:new handler refuses anything from a non-generator role, and the
    // frontend never shows them bidding controls — a read-only view of the live price/feed/result,
    // with generators only ever visible to them by alias (same as they are to each other).
    let buyerLink: { alias: string; organizationName: string; joinUrl: string } | null = null;
    if (buyer) {
      const jti = generateJti();
      const buyerParticipant = await AuctionParticipant.create({
        auctionId: auction.id,
        organizationName: buyer.organizationName,
        alias: buyer.alias,
        role: 'buyer',
        joinTokenId: jti,
      });
      const token = signJoinToken({ auctionId: auction.id, participantId: buyerParticipant.id, alias: buyer.alias, jti });
      buyerLink = {
        alias: buyer.alias,
        organizationName: buyer.organizationName,
        joinUrl: `${frontendOrigin}/auction-live?token=${encodeURIComponent(token)}`,
      };
    }

    // Privileged-action logging: this route creates real auction state with no auth in front of
    // it, so at minimum every call should leave a trace of who/when/what — see the "Identity,
    // authentication and access" checklist. Full RBAC/audit trail is deferred, but this is cheap.
    console.log(
      `[AUCTION_ADMIN] [req=${req.requestId}] seed: auctionId=${auction.id} title="${title}" participants=${participants.length} buyer=${buyer ? buyer.alias : 'none'} ip=${req.ip} at=${new Date().toISOString()}`
    );

    res.json({ success: true, auctionId: auction.id, windowEndsAt, links, buyerLink });
  } catch (err) {
    next(err);
  }
});

// Evidence-export control: lets a customer or auditor pull the full, verifiable record for a
// closed (or in-progress) auction — the hash-chained bid log plus the signed result summary.
// No auth, same as the rest of this file — not something to expose on the real platform as-is.
router.get('/auctions/:id/export', exportLimiter, async (req, res, next) => {
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
      attributes: ['id', 'alias', 'organizationName', 'role', 'rulesAcceptedAt', 'createdAt'],
    });
    const bids = await AuctionBid.findAll({
      where: { auctionId },
      order: [['id', 'ASC']],
      attributes: ['id', 'alias', 'amount', 'accepted', 'rejectReason', 'ipHash', 'prevHash', 'hash', 'createdAt'],
    });

    // While an auction is still live, this endpoint is the highest-value insider position in the
    // whole system: anyone with access to it (this route has no auth) sees the real-time leading
    // rate and could feed it straight to a colluding generator. Redact the rate itself — not the
    // rest of the record — until the auction closes, so integrity (hash chain, timestamps, who bid)
    // stays fully inspectable at any time, but the one thing worth leaking early can't leak.
    const isLive = auction.status === 'live';
    const bidsOut = bids.map((b) => ({
      id: b.id,
      alias: b.alias,
      amount: isLive ? null : b.amount,
      accepted: b.accepted,
      rejectReason: b.rejectReason,
      ipHash: b.ipHash,
      prevHash: b.prevHash,
      hash: b.hash,
      createdAt: b.createdAt,
    }));

    // Privileged-action logging: this route can reveal the full bid chain and result summary for
    // any auction, with no auth in front of it — every call should leave a trace, same as the seed
    // route already does.
    console.log(
      `[AUCTION_ADMIN] [req=${req.requestId}] export: auctionId=${auctionId} status=${auction.status} ip=${req.ip} at=${new Date().toISOString()}`
    );

    res.json({
      success: true,
      liveDataRedacted: isLive,
      auction: {
        id: auction.id,
        title: auction.title,
        status: auction.status,
        openingBid: auction.openingBid,
        currentLowestBid: isLive ? null : auction.currentLowestBid,
        minUndercut: auction.minUndercut,
        winnerParticipantId: auction.winnerParticipantId,
        resultSummary: auction.resultSummaryJson ? JSON.parse(auction.resultSummaryJson) : null,
        resultHash: auction.resultHash,
      },
      participants,
      bids: bidsOut,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
