import { Router } from 'express';
import rateLimit from 'express-rate-limit';
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
  tenderRef: number
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
          return sendAuctionJoinLinkEmail(org.contactEmail, title, frontendUrl(joinPath));
        })
        .catch((err) => {
          logger.error({ err, auctionId: auction.id, generatorOrgId: p.generatorOrgId }, '[VETTING_BRIDGE] auction join-link email failed — auction unaffected');
        });
    }
  }

  const windowEndsAt = await startAuctionClock(auction.id, DEFAULT_WINDOW_SECONDS);
  await Auction.update({ status: 'live' }, { where: { id: auction.id } });

  return { auctionId: auction.id, windowEndsAt, links };
}

// Promotes a tender's approved, financially-opened generators into a live auction — see
// VETTING_TO_AUCTION_BRIDGE_PLAN.md. Requires the financial ceremony to have already run for this
// tenderRef; computes the opening bid as the lowest financial bid among approved generators.
router.post('/vetting-bids/:tenderRef/promote-to-auction', promoteLimiter, async (req, res, next) => {
  try {
    const tenderRef = Number(req.params.tenderRef);
    if (!Number.isFinite(tenderRef)) return res.status(400).json({ success: false, error: 'Invalid tenderRef' });

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
      tenderRef
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
