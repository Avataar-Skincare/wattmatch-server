import { Op } from 'sequelize';
import { Tender } from '../models/Tender.js';
import { VettingCustodian } from '../models/VettingCustodian.js';
import { VettingCustodianToken } from '../models/VettingCustodianToken.js';
import { generateOpaqueToken } from '../lib/passwordAuth.js';
import { sendCustodianCeremonyLinkEmail } from './email.js';
import { logger } from '../lib/logger.js';
import type { VettingEnvelope } from '../models/VettingOpeningAttestation.js';

// A ceremony-instance token per custodian per (tender, envelope), valid from now until well past the
// scheduled open date — generous on purpose: a custodian who doesn't act the same day shouldn't be
// permanently locked out, only re-invited via the resend route if their window truly lapses.
const CEREMONY_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function frontendUrl(path: string): string {
  const origin = process.env.CORS_ORIGIN ?? 'http://localhost:5173';
  return `${origin}${path}`;
}

// Called when a tender's scheduled technicalBidOpenAt/financialBidOpenAt arrives (routes/tenders.ts's
// in-process timer, same accepted pattern as vettingAuctionBridge.ts's auction-start timer — lost on
// a restart between scheduling and firing, recovered via the admin-only resend route), or directly
// from that resend route. One token row per (custodian, tender, envelope) — a resend re-mints the
// plaintext token and overwrites the existing row's hash (rather than inserting a second row, which
// the table's unique constraint on that triple wouldn't allow anyway) so the old link stops working
// and the new one is what actually gets emailed — exactly the "my email never arrived, send it
// again" recovery this route exists for.
// onlyCustodianIds narrows which custodians get (re-)notified — used by notifyOverdueCustodians
// below to retry just the ones actually missing a token, without re-minting (and thereby
// invalidating) a token for a custodian who was already notified successfully. Omitted entirely by
// the original scheduled-timer call site and the manual admin resend route, both of which
// legitimately mean "everyone."
export async function notifyCustodians(tenderId: number, envelope: VettingEnvelope, onlyCustodianIds?: number[]): Promise<void> {
  const tender = await Tender.findByPk(tenderId);
  if (!tender) {
    logger.error({ tenderId, envelope }, '[CUSTODIAN_NOTIFY] tender not found — nothing to notify');
    return;
  }

  const allCustodians = await VettingCustodian.findAll();
  const custodians = onlyCustodianIds ? allCustodians.filter((c) => onlyCustodianIds.includes(c.id)) : allCustodians;
  if (custodians.length === 0) {
    logger.error({ tenderId, envelope }, '[CUSTODIAN_NOTIFY] no custodians on file — nobody to email');
    return;
  }

  for (const custodian of custodians) {
    try {
      const { token, tokenHash } = generateOpaqueToken();
      const expiresAt = new Date(Date.now() + CEREMONY_TOKEN_TTL_MS);
      const existing = await VettingCustodianToken.findOne({ where: { custodianId: custodian.id, tenderId, envelope } });
      if (existing) {
        await existing.update({ tokenHash, expiresAt, usedAt: null });
      } else {
        await VettingCustodianToken.create({ custodianId: custodian.id, tenderId, envelope, tokenHash, expiresAt });
      }
      const ceremonyUrl = frontendUrl(`/custodian-ceremony?token=${encodeURIComponent(token)}`);
      await sendCustodianCeremonyLinkEmail(custodian.email, custodian.name, tender.id, tender.title, envelope, ceremonyUrl);
    } catch (err) {
      // One custodian's failure (bad email, transient DB error) must not stop the others from being
      // notified — same "don't let one failure take down the rest" reasoning used throughout this
      // codebase's fire-and-forget notification loops (e.g. tenders.ts's autoInviteEligibleGenerators).
      logger.error({ err, tenderId, envelope, custodianId: custodian.id }, '[CUSTODIAN_NOTIFY] failed for one custodian — continuing with the rest');
    }
  }

  logger.info({ tenderId, envelope, custodianCount: custodians.length }, '[CUSTODIAN_NOTIFY] ceremony invites sent');
}

const CUSTODIAN_NOTIFICATION_CHECK_INTERVAL_MS = 60 * 1000;

// Self-heals tenders.ts's own documented gap: a server restart between tender creation and the
// scheduled open date loses the in-process setTimeout that would have called notifyCustodians,
// leaving custodians never invited with no automatic path to fix it (until someone notices and
// clicks the admin-only resend route). Deliberately per-CUSTODIAN, not just per-(tender,envelope):
// notifyCustodians already tolerates one custodian's send failing without stopping the others (see
// its own comment), but that means a partial run — custodian A succeeds, custodian B's email throws
// — used to leave one token row behind, and a coarser "does ANY token exist for this tender/
// envelope" check would then skip retrying it forever, silently stranding just custodian B with no
// automatic recovery. Comparing against every custodian on file catches that partial case too, not
// just the "nobody was ever notified" case.
export async function notifyOverdueCustodians(): Promise<void> {
  const now = new Date();
  const overdue = await Tender.findAll({
    where: { [Op.or]: [{ technicalBidOpenAt: { [Op.lte]: now } }, { financialBidOpenAt: { [Op.lte]: now } }] },
  });
  const allCustodianIds = (await VettingCustodian.findAll()).map((c) => c.id);

  for (const tender of overdue) {
    for (const envelope of ['technical', 'financial'] as VettingEnvelope[]) {
      const openAt = envelope === 'technical' ? tender.technicalBidOpenAt : tender.financialBidOpenAt;
      if (!openAt || openAt.getTime() > now.getTime()) continue;
      try {
        const existingTokens = await VettingCustodianToken.findAll({ where: { tenderId: tender.id, envelope } });
        const notifiedCustodianIds = new Set(existingTokens.map((t) => t.custodianId));
        const missingCustodianIds = allCustodianIds.filter((id) => !notifiedCustodianIds.has(id));
        if (missingCustodianIds.length === 0) continue;
        await notifyCustodians(tender.id, envelope, missingCustodianIds);
        logger.info({ tenderId: tender.id, envelope, missingCustodianIds }, '[CUSTODIAN_NOTIFY] check loop caught custodians missing a notification');
      } catch (err) {
        logger.error({ err, tenderId: tender.id, envelope }, '[CUSTODIAN_NOTIFY] check loop failed for one tender/envelope — continuing');
      }
    }
  }
}

// Same recursive-setTimeout, self-healing poll pattern already used for auction close-checking
// (auctionSocket.ts's startCloseCheckLoop) and scheduled auction activation
// (auctionEngine.ts's startScheduledAuctionActivationLoop) — one tender's error can't wedge every
// future tick, and a missed notification is caught within one interval of the server coming back
// up, not left stuck until someone notices via the manual resend route.
export function startCustodianNotificationCheckLoop(): void {
  async function tick() {
    try {
      await notifyOverdueCustodians();
    } catch (err) {
      logger.error({ err }, '[CUSTODIAN_NOTIFY] check loop failed');
    } finally {
      setTimeout(tick, CUSTODIAN_NOTIFICATION_CHECK_INTERVAL_MS);
    }
  }
  setTimeout(tick, CUSTODIAN_NOTIFICATION_CHECK_INTERVAL_MS);
}
