import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { VettingBid } from '../models/VettingBid.js';
import { VettingDecidedRecord } from '../models/VettingDecidedRecord.js';
import { VettingOpeningAttestation } from '../models/VettingOpeningAttestation.js';
import { Auction } from '../models/Auction.js';
import { AuctionParticipant } from '../models/AuctionParticipant.js';
import { Organization } from '../models/Organization.js';
import { generateJti, signJoinToken } from '../lib/auctionTokens.js';
import { initAuctionState, startAuctionClock, MIN_UNDERCUT } from '../services/auctionEngine.js';
import { encryptField, decryptField } from '../lib/fieldEncryption.js';
import { sendAuctionJoinLinkEmail } from '../services/email.js';
import { logger } from '../lib/logger.js';

const router = Router();

const promoteLimiter = rateLimit({ windowMs: 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

function frontendUrl(path: string): string {
  const origin = process.env.CORS_ORIGIN ?? 'http://localhost:5173';
  return `${origin}${path}`;
}

// Sensible defaults matching auctionAdmin.ts's seedBodySchema defaults — this bridge doesn't
// accept these as caller input (no tender-level config for them exists yet), just uses the same
// platform defaults the manual seed path falls back to.
const DEFAULT_WINDOW_SECONDS = 480;
const DEFAULT_MAX_AUTO_EXTENSIONS = 8;

// setTimeout's delay is a 32-bit signed int internally (~24.8 days is the real ceiling) — capped
// well under that, both to stay safely inside it and because a "schedule this auction weeks out"
// request is almost certainly a mistake for a live-bidding tool like this one.
const MAX_SCHEDULE_AHEAD_MS = 20 * 24 * 60 * 60 * 1000;
// scheduledStartAt is mandatory (§ product decision: an auction must never go live the moment it's
// generated) — this is the minimum lead time a requested start must clear, so "schedule it" can't
// be defeated by picking a time a second from now. Generous enough to rule out any realistic
// request-latency false positive, small enough to never get in a real admin's way.
const MIN_SCHEDULE_AHEAD_MS = 60 * 1000;

const promoteBodySchema = z
  .object({
    // Required — ISO 8601 datetime string, matching what `Date.prototype.toISOString()` produces.
    // No "omit this to start immediately" path any more: every auction this bridge creates must be
    // scheduled for a real future time, never live the instant it's generated.
    scheduledStartAt: z.string().datetime(),
  })
  .strict();

// DELIBERATE DUPLICATION, not a refactor — see VETTING_TO_AUCTION_BRIDGE_PLAN.md. This
// intentionally does NOT share code with auctionAdmin.ts's /auctions/seed route: that file is
// working, tested, and directly relied on by live demos, and extracting a shared function from it
// is exactly the kind of change that risks a regression in code a real demo depends on. This
// route reimplements the same auction-creation sequence independently instead. The two paths
// should be unified into one shared function later (tracked in the bridge plan), once that
// refactor can be done and verified without any live-demo risk.
async function seedAuctionStandalone(
  title: string,
  openingBid: number,
  participants: Array<{ alias: string; organizationName: string; generatorOrgId: number | null }>,
  tenderRef: number,
  scheduledStartAt: Date
) {
  // Same ordering rationale already established for the manual seed route: create 'scheduled',
  // start the clock only once every participant has a real join link ready, flip to 'live' last.
  const auction = await Auction.create({
    title,
    status: 'scheduled',
    openingBid: String(openingBid),
    currentLowestBid: String(openingBid),
    windowSeconds: DEFAULT_WINDOW_SECONDS,
    maxAutoExtensions: DEFAULT_MAX_AUTO_EXTENSIONS,
    minUndercut: String(MIN_UNDERCUT),
    tenderRef,
  });

  await initAuctionState(auction.id, openingBid, DEFAULT_WINDOW_SECONDS, DEFAULT_MAX_AUTO_EXTENSIONS, MIN_UNDERCUT);

  const links = [];
  for (const p of participants) {
    const jti = generateJti();
    const participant = await AuctionParticipant.create({
      auctionId: auction.id,
      organizationName: await encryptField(p.organizationName),
      alias: p.alias,
      role: 'generator',
      joinTokenId: jti,
    });
    const token = await signJoinToken({ auctionId: auction.id, participantId: participant.id, alias: p.alias, jti });
    const joinPath = `/auction-live?token=${encodeURIComponent(token)}`;
    links.push({ alias: p.alias, joinUrl: joinPath });

    // Stage 7: "Approved generators receive a scheduled auction link" — fire-and-forget, same as
    // invoiceService.ts's hook: a slow/broken email send must never delay the auction actually
    // going live for everyone else. generatorOrgId is null for placeholder/legacy submissions
    // (see VettingBid's own comment) — nothing to email in that case, skip silently rather than
    // failing the whole promotion over one missing link.
    if (p.generatorOrgId !== null) {
      Organization.findByPk(p.generatorOrgId)
        .then((org) => {
          if (!org) return;
          return sendAuctionJoinLinkEmail(org.contactEmail, title, frontendUrl(joinPath), scheduledStartAt);
        })
        .catch((err) => {
          logger.error({ err, auctionId: auction.id, generatorOrgId: p.generatorOrgId }, '[VETTING_BRIDGE] auction join-link email failed — auction unaffected');
        });
    }
  }

  // In-process timer only, same PoC bar as the rest of this internal bridge (see module comment)
  // — a server restart between now and scheduledStartAt loses this timer and the auction is stuck
  // 'scheduled' forever, needing a manual fix. Fine for this tool; a real deployment would need a
  // persistent job (durable queue or a DB-polled scheduler) instead. The auction is created (and
  // stays) 'scheduled' here — startAuctionClock/status:'live' only ever happen later, inside this
  // timer, never at generation time.
  const delayMs = scheduledStartAt.getTime() - Date.now();
  setTimeout(() => {
    startAuctionClock(auction.id, DEFAULT_WINDOW_SECONDS)
      .then(() => Auction.update({ status: 'live' }, { where: { id: auction.id } }))
      .then(() => {
        logger.info({ auctionId: auction.id, scheduledStartAt }, '[VETTING_BRIDGE] scheduled auction went live');
      })
      .catch((err) => {
        logger.error({ err, auctionId: auction.id }, '[VETTING_BRIDGE] scheduled auction failed to go live');
      });
  }, delayMs);

  return { auctionId: auction.id, scheduledStartAt: scheduledStartAt.toISOString(), links };
}

// Promotes a tender's approved, financially-opened generators into a live auction — see
// VETTING_TO_AUCTION_BRIDGE_PLAN.md. Requires the financial ceremony to have already run for this
// tenderRef; computes the opening bid as the lowest financial bid among approved generators.
router.post('/vetting-bids/:tenderRef/promote-to-auction', promoteLimiter, async (req, res, next) => {
  try {
    const tenderRef = Number(req.params.tenderRef);
    if (!Number.isFinite(tenderRef)) return res.status(400).json({ success: false, error: 'Invalid tenderRef' });

    const parsedBody = promoteBodySchema.safeParse(req.body ?? {});
    if (!parsedBody.success) {
      return res.status(400).json({ success: false, error: parsedBody.error.issues.map((i) => i.message).join('; ') });
    }
    const scheduledStartAt = new Date(parsedBody.data.scheduledStartAt);
    const aheadMs = scheduledStartAt.getTime() - Date.now();
    if (aheadMs < MIN_SCHEDULE_AHEAD_MS) {
      return res.status(400).json({
        success: false,
        error: `Scheduled start must be at least ${MIN_SCHEDULE_AHEAD_MS / 1000} seconds from now — auctions are never generated live.`,
      });
    }
    if (aheadMs > MAX_SCHEDULE_AHEAD_MS) {
      return res.status(400).json({
        success: false,
        error: `Scheduled start must be within ${MAX_SCHEDULE_AHEAD_MS / (24 * 60 * 60 * 1000)} days from now`,
      });
    }

    const financialAttestation = await VettingOpeningAttestation.findOne({ where: { tenderRef: String(tenderRef), envelope: 'financial' } });
    if (!financialAttestation) {
      return res.status(409).json({ success: false, error: 'Financial ceremony has not been run for this tender yet' });
    }

    // Double-promotion guard — an Auction already tied to this tenderRef means it's already been
    // promoted; do not seed a second live auction from the same tender.
    const existing = await Auction.findOne({ where: { tenderRef } });
    if (existing) {
      return res.status(409).json({ success: false, error: `This tender was already promoted to auction #${existing.id}` });
    }

    const approvedBids = await VettingBid.findAll({ where: { tenderRef: String(tenderRef), technicalStatus: 'approved' } });
    if (approvedBids.length === 0) {
      return res.status(400).json({ success: false, error: 'No approved generators with opened financial bids to promote' });
    }

    const participants: Array<{ alias: string; organizationName: string; tariff: number; generatorOrgId: number | null }> = [];
    for (const bid of approvedBids) {
      const record = await VettingDecidedRecord.findOne({ where: { vettingBidId: bid.id, envelope: 'financial' } });
      if (!record) continue; // approved but financial envelope wasn't opened for this one — skip, don't fail the whole promotion
      const content = await decryptField(record.encryptedContent);
      let tariff: number;
      try {
        // Placeholder shape — see VETTING_TO_AUCTION_BRIDGE_PLAN.md: real financial-bid form
        // fields are still undefined, this bridge expects {"tariff": number} until that lands.
        tariff = JSON.parse(content).tariff;
      } catch {
        continue;
      }
      if (typeof tariff !== 'number' || !Number.isFinite(tariff)) continue;
      // organizationName placeholder: VettingBid doesn't separately capture a real company name
      // yet — using applicantAlias for both, flagged in the plan as a known placeholder.
      participants.push({ alias: bid.applicantAlias, organizationName: bid.applicantAlias, tariff, generatorOrgId: bid.generatorOrgId });
    }

    if (participants.length === 0) {
      return res.status(400).json({ success: false, error: 'No approved generators have an opened financial bid yet' });
    }

    const openingBid = Math.min(...participants.map((p) => p.tariff));

    const result = await seedAuctionStandalone(
      `Tender #${tenderRef} auction`,
      openingBid,
      participants.map((p) => ({ alias: p.alias, organizationName: p.organizationName, generatorOrgId: p.generatorOrgId })),
      tenderRef,
      scheduledStartAt
    );

    logger.info(
      { reqId: req.requestId, tenderRef, auctionId: result.auctionId, participantCount: participants.length, openingBid },
      '[VETTING_BRIDGE] tender promoted to auction'
    );

    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
});

export default router;
