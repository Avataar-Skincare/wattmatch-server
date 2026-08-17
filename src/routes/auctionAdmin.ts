import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Auction } from '../models/Auction.js';
import { AuctionParticipant } from '../models/AuctionParticipant.js';
import { AuctionBid } from '../models/AuctionBid.js';
import { generateJti, signJoinToken, verifyJoinToken } from '../lib/auctionTokens.js';
import { initAuctionState, startAuctionClock, MIN_UNDERCUT, MAX_BID_AMOUNT } from '../services/auctionEngine.js';
import { encryptField, decryptField } from '../lib/fieldEncryption.js';
import { logger } from '../lib/logger.js';

const router = Router();

// Upper bounds on seed inputs — without these, a caller-supplied value only fails once it hits a
// raw DB error deep in Auction.create() (windowSeconds/maxAutoExtensions are INTEGER.UNSIGNED,
// openingBid a DECIMAL(10,4)), instead of a clean 400 here. Generous enough for any real tender
// timeline (30 days, 1000 extensions) while still bounded well short of what would actually
// overflow the column or just be a nonsensical config.
export const MAX_WINDOW_SECONDS = 30 * 24 * 60 * 60;
export const MAX_AUTO_EXTENSIONS_CAP = 1000;

// A declared schema catches the whole shape at once — this replaced a hand-written chain of if
// conditions that, in practice, turned out to have real gaps (missing per-participant checks,
// missing upper bounds) only found by manual review. The schema can't have that kind of silent gap:
// every field's constraints live in one place, and anything not listed here is simply not accepted.
// max(255) matches the underlying columns' default VARCHAR(255) — without it, an overlong value
// passes this schema fine and only fails at the DB insert as a raw "data truncated" error (a 500),
// instead of a clean 400 telling the caller exactly what was wrong.
const MAX_STRING_FIELD_LENGTH = 255;
const seedParticipantSchema = z.object({
  organizationName: z.string().trim().min(1, 'organizationName must be a non-empty string').max(MAX_STRING_FIELD_LENGTH, `organizationName must be at most ${MAX_STRING_FIELD_LENGTH} characters`),
  alias: z.string().trim().min(1, 'alias must be a non-empty string').max(MAX_STRING_FIELD_LENGTH, `alias must be at most ${MAX_STRING_FIELD_LENGTH} characters`),
});

// Exported for direct unit testing (see auctionAdmin.test.ts) — otherwise the only way to exercise
// this validation is through a full HTTP request against a running server.
export const seedBodySchema = z
  .object({
    title: z.string().trim().min(1, 'title is required').max(MAX_STRING_FIELD_LENGTH, `title must be at most ${MAX_STRING_FIELD_LENGTH} characters`),
    openingBid: z.number().positive().max(MAX_BID_AMOUNT, `openingBid must be at most ${MAX_BID_AMOUNT}`),
    windowSeconds: z.number().int().positive().max(MAX_WINDOW_SECONDS, `windowSeconds must be at most ${MAX_WINDOW_SECONDS}`).default(480),
    maxAutoExtensions: z.number().int().min(0).max(MAX_AUTO_EXTENSIONS_CAP, `maxAutoExtensions must be at most ${MAX_AUTO_EXTENSIONS_CAP}`).default(8),
    participants: z.array(seedParticipantSchema).min(1, 'at least one participant is required'),
    // Optional — a real listing always has one, but plenty of PoC/demo runs don't need a spectator
    // seat at all. A buyer is otherwise seated exactly like a generator (same join-token mechanism,
    // same alias-only exposure) except never allowed to bid — see auctionSocket.ts's role check.
    buyer: seedParticipantSchema.optional(),
  })
  // The whole live protocol identifies bidders by alias only (leaderAlias) — a duplicate alias
  // within one auction would make it impossible to tell who's actually leading, or would let the
  // buyer's own alias collide with a generator's.
  .refine(
    (body) => {
      const aliases = body.participants.map((p) => p.alias).concat(body.buyer ? [body.buyer.alias] : []);
      return new Set(aliases).size === aliases.length;
    },
    { message: 'Participant (and buyer) aliases must be unique within an auction', path: ['participants'] }
  );

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
const identityRevealLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many identity-reveal requests from this IP — try again shortly.' },
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
    const parsed = seedBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((issue) => issue.message).join('; ') });
    }
    const { title, openingBid, windowSeconds, maxAutoExtensions, participants, buyer } = parsed.data;

    // minUndercut is intentionally NOT accepted from the request body — it's a flat platform rule
    // (AUCTION_PLAN.md), not something a seed caller gets to configure per auction. Snapshotting the
    // current constant here is purely for rule-version tracking (see Auction.minUndercut's comment).
    // Created 'scheduled', not 'live' — the countdown only starts once every participant below
    // actually has a join link ready (see the startAuctionClock call after the loops). Marking it
    // 'live' here immediately would both start burning real bidding time against DB/token-signing
    // latency in the loops below, and — since the close-check tick in auctionSocket.ts only treats
    // a missing Redis key as "restart lost it, reconstruct" for auctions the DB says are 'live' —
    // create a narrow window where a normal in-progress seed (DB row live, Redis not yet
    // initialized) could be mistaken for exactly that.
    const auction = await Auction.create({
      title,
      status: 'scheduled',
      openingBid: String(openingBid),
      currentLowestBid: String(openingBid),
      windowSeconds,
      maxAutoExtensions,
      minUndercut: String(MIN_UNDERCUT),
    });

    await initAuctionState(auction.id, openingBid, windowSeconds, maxAutoExtensions, MIN_UNDERCUT);

    // Falls back to localhost silently — fine for local dev, but if CORS_ORIGIN is ever missed in
    // a real deployment this would still return 200 OK with join links that look valid but point
    // nowhere for real users. Warning loudly (same pattern as auctionTokens.ts's JWT secret check)
    // so it's at least visible in the server logs rather than a mystery bug report later.
    if (!process.env.CORS_ORIGIN) {
      logger.warn('CORS_ORIGIN is not set — generated join links point at localhost, not a real deployment URL.');
    }
    const frontendOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:5173';
    const links = [];
    for (const p of participants) {
      const jti = generateJti();
      // organizationName is encrypted at rest (see LIVE_AUCTION_IDENTITY_ENCRYPTION_PLAN.md) — the
      // plaintext name from the request is used for the response's join-link labels below (the
      // caller already knows what they just submitted), never re-read from the stored ciphertext.
      const participant = await AuctionParticipant.create({
        auctionId: auction.id,
        organizationName: await encryptField(p.organizationName),
        alias: p.alias,
        role: 'generator',
        joinTokenId: jti,
      });
      const token = await signJoinToken({ auctionId: auction.id, participantId: participant.id, alias: p.alias, jti });
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
        organizationName: await encryptField(buyer.organizationName),
        alias: buyer.alias,
        role: 'buyer',
        joinTokenId: jti,
      });
      const token = await signJoinToken({ auctionId: auction.id, participantId: buyerParticipant.id, alias: buyer.alias, jti });
      buyerLink = {
        alias: buyer.alias,
        organizationName: buyer.organizationName,
        joinUrl: `${frontendOrigin}/auction-live?token=${encodeURIComponent(token)}`,
      };
    }

    // Only now — with every participant (and buyer) already holding a valid join link — does the
    // countdown actually start and the auction become joinable/biddable. If anything above threw,
    // the auction is left 'scheduled' with whichever participants were created before the failure,
    // which is inert (the close-check loop ignores non-'live' auctions) rather than a live, ticking
    // auction the caller has no links for and no way to recover.
    const windowEndsAt = await startAuctionClock(auction.id, windowSeconds);
    await Auction.update({ status: 'live' }, { where: { id: auction.id } });

    // Privileged-action logging: this route creates real auction state with no auth in front of
    // it, so at minimum every call should leave a trace of who/when/what — see the "Identity,
    // authentication and access" checklist. Full RBAC/audit trail is deferred, but this is cheap.
    logger.info(
      { reqId: req.requestId, auctionId: auction.id, title, participantCount: participants.length, buyerAlias: buyer?.alias ?? null, ip: req.ip },
      'auction seeded'
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

    // organizationName is deliberately excluded — it's encrypted at rest specifically because the
    // live protocol's identity-hiding property (alias-only exposure) shouldn't be undermined by an
    // export route returning the real name right back out. This route has no auth in front of it
    // (see its own comment), so there's no legitimate caller to decrypt it for here; a real
    // "reveal winner's identity" flow needs actual admin/buyer auth first — not built yet.
    const participants = await AuctionParticipant.findAll({
      where: { auctionId },
      attributes: ['id', 'alias', 'role', 'rulesAcceptedAt', 'createdAt'],
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
    logger.info({ reqId: req.requestId, auctionId, status: auction.status, ip: req.ip }, 'auction export accessed');

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

// Winning-pair identity reveal (see LIVE_AUCTION_IDENTITY_ENCRYPTION_PLAN.md's "follow-up" and
// BID_SEALING_BUILD_CHECKLIST.md's C.5: "Auto-reveal of identity for the winning pair only, on
// auction close. Losing bidders' identities remain sealed post-auction."). This is the one
// legitimate reason organizationName ever needs to be decrypted: the buyer needs the winning
// generator's real company to execute a PPA, and the winner needs to know who they're contracting
// with. Everyone else — losing generators, anyone without a token at all — gets nothing.
//
// There's no admin/user auth system yet (same gap as every other route in this file), so this
// can't be gated behind a real role check. Instead of leaving it unbuilt until that exists, it
// reuses the one piece of identity proof that already exists: a participant's own join token
// (the same JWT already handed to them for socket auth) proves who they are without needing a
// separate login system. A caller without a valid token for this specific auction gets nothing,
// and a caller who has a valid token but isn't the winner or the buyer also gets nothing — only
// the two counterparties who actually need to contract with each other can ever see this.
router.get('/auctions/:id/winner-identity', identityRevealLimiter, async (req, res, next) => {
  try {
    const auctionId = Number(req.params.id);
    if (!Number.isFinite(auctionId)) {
      return res.status(400).json({ success: false, error: 'Invalid auction id' });
    }

    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
    if (!token) {
      return res.status(401).json({ success: false, error: 'Missing join token' });
    }

    let payload;
    try {
      // Expiry deliberately ignored here (unlike the live socket auth path) — this route is only
      // ever reachable post-close, potentially days after the 24h live window ends, and a buyer or
      // winner legitimately needing to execute a contract shouldn't be permanently locked out just
      // because they didn't act within a day. Safe to relax specifically here because the
      // requester's identity is still independently re-checked against a live AuctionParticipant
      // row below (id/auctionId/jti must all still match) — an expired-but-otherwise-genuine token
      // proves the same thing a fresh one would; a forged or tampered one still fails verification.
      payload = await verifyJoinToken(token, { ignoreExpiration: true });
    } catch (err) {
      logger.warn({ reqId: req.requestId, auctionId, err }, '[AUCTION_IDENTITY] rejected: invalid token');
      return res.status(401).json({ success: false, error: 'Invalid join token' });
    }
    if (payload.auctionId !== auctionId) {
      return res.status(403).json({ success: false, error: 'This token does not belong to this auction' });
    }

    const auction = await Auction.findByPk(auctionId);
    if (!auction) return res.status(404).json({ success: false, error: 'Auction not found' });
    // Checked before looking up the requester so a losing generator can't use timing/error-shape
    // differences to learn anything about the auction's outcome before it's actually final.
    if (auction.status !== 'closed') {
      return res.status(409).json({ success: false, error: 'Identity reveal is only available after the auction closes' });
    }
    if (!auction.winnerParticipantId) {
      return res.status(404).json({ success: false, error: 'This auction closed with no winner' });
    }

    // joinTokenId check mirrors auctionSocket.ts's own auth middleware exactly — same reasoning:
    // confirms this is a real, still-valid participant record, not just a structurally-valid JWT.
    const requester = await AuctionParticipant.findOne({
      where: { id: payload.participantId, auctionId, joinTokenId: payload.jti },
    });
    if (!requester) {
      return res.status(401).json({ success: false, error: 'Unknown or revoked join token' });
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

    // Privileged-action logging, same convention as seed/export — this is the one route in the
    // whole module that ever turns encrypted identity back into plaintext, so every call is worth
    // a permanent trace of exactly who saw whose identity and when.
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
