import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { sequelize } from './db/sequelize.js';
import { auditSequelize } from './db/auditSequelize.js';
import { redis } from './lib/redis.js';
import { logger } from './lib/logger.js';
import leadsRouter from './routes/leads.js';
import contactRouter from './routes/contact.js';
import adminRouter from './routes/admin.js';
// OTP verification was removed from the registration flow — route kept
// commented out (routes/otp.ts) in case it's reintroduced later.
// import otpRouter from './routes/otp.js';
import registrationsRouter from './routes/registrations.js';
import auctionsRouter from './routes/auctions.js';
import auctionAdminRouter from './routes/auctionAdmin.js';
import vettingBidsRouter from './routes/vettingBids.js';
import vettingCustodianRouter from './routes/vettingCustodian.js';
import vettingAuctionBridgeRouter from './routes/vettingAuctionBridge.js';
import organizationsRouter from './routes/organizations.js';
import tendersRouter from './routes/tenders.js';
import tenderDocumentsRouter from './routes/tenderDocuments.js';
import emdSubmissionsRouter from './routes/emdSubmissions.js';
import paymentsRouter from './routes/payments.js';
import devLocalStorageRouter from './routes/devLocalStorage.js';
import { setupAuctionSocket } from './sockets/auctionSocket.js';
import { startScheduledAuctionActivationLoop } from './services/auctionEngine.js';
import { startCustodianNotificationCheckLoop } from './services/custodianNotificationService.js';
import { startPaymentReconciliationLoop } from './services/paymentReconciliationService.js';
import { startInvoiceGenerationCheckLoop } from './services/invoiceService.js';

const app = express();
const port = process.env.PORT ?? 4000;

// TRUST_PROXY_HOPS: the number of reverse-proxy hops in front of this process (e.g. an ALB/
// CloudFront in front of the app = 1). Every route's rate limiter (lib/rateLimit.ts) keys on
// req.ip, which without this reads as the proxy's own IP for every request once deployed behind
// one — bucketing every real caller together and effectively disabling those limits. Left unset
// (today's behavior) outside a real deployment; set explicitly once the real hop count is known —
// guessing wrong would let a caller spoof X-Forwarded-For to dodge the limit, which is worse than
// leaving it unset until the real count is confirmed.
const trustProxyHops = process.env.TRUST_PROXY_HOPS ? Number(process.env.TRUST_PROXY_HOPS) : undefined;
if (trustProxyHops !== undefined) app.set('trust proxy', trustProxyHops);
else if (process.env.NODE_ENV === 'production') {
  // A missing value is silent and easy to miss until someone notices rate limits aren't actually
  // limiting anything — this makes the gap visible at boot instead of only during an incident.
  logger.warn('TRUST_PROXY_HOPS is not set in production — every IP-keyed rate limiter will bucket all callers behind the same reverse proxy together.');
}

app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173' }));
// `verify` captures the exact raw bytes into req.rawBody alongside normal JSON parsing — needed by
// the Razorpay webhook route's HMAC check, which must sign the literal bytes Razorpay sent, not a
// re-serialized copy of the parsed object (JSON.stringify(JSON.parse(x)) is not guaranteed to
// reproduce x byte-for-byte). This is the adapted equivalent of "mount express.raw() before
// express.json()" for a codebase where express.json() is already global and used by every other
// route — reordering registration to exempt one route would be far more invasive than capturing
// the raw buffer here for the one handler that actually needs it.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));

// CERT-In floor: log lines need a consistent correlation ID so one bid submission (or any other
// request) can be traced end-to-end across services from logs alone — see AUCTION_PLAN.md/
// COMPLIANCE_CHECKLIST.md. Generated fresh per request rather than trusting an inbound header,
// since a caller-supplied ID could be used to collide with or spoof another request's trace.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

declare module 'node:http' {
  interface IncomingMessage {
    // Set by express.json()'s `verify` callback above — declared on IncomingMessage (which
    // Express.Request extends) rather than Express.Request directly, since body-parser's `verify`
    // callback itself is typed against the raw Node IncomingMessage, not Express's Request.
    rawBody?: Buffer;
  }
}

app.use((req, res, next) => {
  req.requestId = crypto.randomBytes(8).toString('hex');
  res.setHeader('X-Request-Id', req.requestId);
  const start = Date.now();
  res.on('finish', () => {
    logger.info(
      { reqId: req.requestId, method: req.method, url: req.originalUrl, statusCode: res.statusCode, durationMs: Date.now() - start },
      'request completed'
    );
  });
  next();
});

// Previously returned { ok: true } unconditionally, with no check of MySQL, the restricted audit
// connection, or Redis — a load balancer/uptime monitor could see "healthy" while every DB-backed
// route was actually failing (especially combined with start()'s own connection failures below
// being logged rather than fatal). Each dependency gets its own short-timeout check so one hung
// connection can't make this route hang too; the response is 200 only if every dependency answers.
const HEALTH_CHECK_TIMEOUT_MS = 2000;

async function checkHealthy(check: () => Promise<unknown>): Promise<boolean> {
  try {
    await Promise.race([
      check(),
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error('timed out')), HEALTH_CHECK_TIMEOUT_MS)),
    ]);
    return true;
  } catch {
    return false;
  }
}

app.get('/api/health', async (_req, res) => {
  const [mysql, auditMysql, redisOk] = await Promise.all([
    checkHealthy(() => sequelize.authenticate()),
    checkHealthy(() => auditSequelize.authenticate()),
    checkHealthy(() => redis.ping()),
  ]);
  const ok = mysql && auditMysql && redisOk;
  res.status(ok ? 200 : 503).json({ ok, dependencies: { mysql, auditMysql, redis: redisOk } });
});
app.use('/api/leads', leadsRouter);
app.use('/api/contact', contactRouter);
app.use('/api/admin', adminRouter);
// app.use('/api/otp', otpRouter);
app.use('/api/registrations', registrationsRouter);
// Participant-facing auction routes (join, winner-identity) — org-login-gated, see routes/auctions.ts.
app.use('/api', auctionsRouter);
// PoC-only: reverse-auction MVP, see AUCTION_MVP_PLAN.md. Manual seed/export routes are admin-only
// (middleware/auth.ts) — kept as an admin manual-override tool alongside the real vetting-to-
// auction promotion path (vettingAuctionBridge.ts), not meant to be the primary flow.
app.use('/api/auction-admin', auctionAdminRouter);
// Sealed technical + financial bid module (pre-auction stage) — see
// VETTING_BID_SEALING_IMPLEMENTATION_PLAN.md. Decision/list/decided-record/opened routes are
// admin-only; submission and public-keys require any real org token — see middleware/auth.ts.
app.use('/api', vettingBidsRouter);
// Custodian ceremony — a custodian's own emailed per-(tender, envelope) link, not an admin login.
// See middleware/custodianAuth.ts and routes/vettingCustodian.ts's own comment for why this is
// deliberately separate from every other route in this codebase.
app.use('/api', vettingCustodianRouter);
// Vetting -> live auction bridge — see VETTING_TO_AUCTION_BRIDGE_PLAN.md. Admin-only. Deliberately
// does not share code with auctionAdmin.ts's seed route (see that route's own comment) to avoid
// touching tested, demo-critical code.
app.use('/api', vettingAuctionBridgeRouter);
// Buyer/generator/admin registration + tender posting/matching — see
// MINIMAL_PIPELINE_INTEGRATION_PLAN.md. orgAuth.ts's org-session JWT (email+password login via
// passwordAuth.ts) is the real, only auth mechanism gating every non-public route in this
// codebase — see middleware/auth.ts.
app.use('/api', organizationsRouter);
app.use('/api', tendersRouter);
// Stage 6.1/6.2/6.3's document checklist — see TENDER_WORKFLOW_STAKEHOLDER_PLAN.md.
app.use('/api', tenderDocumentsRouter);
// EMD as a Bank Guarantee document, not money — see EmdSubmission's own comment.
app.use('/api', emdSubmissionsRouter);
// Razorpay order creation — RfS Document and Bid Processing fees only; EMD and Success Charge are
// no longer real payments (see Payment.ts / EmdSubmission.ts).
app.use('/api', paymentsRouter);
// Dev-only stand-in for S3 signed-URL downloads when AWS_S3_BUCKET isn't configured — see
// lib/s3.ts. Always inert (404s everything) once a real bucket is configured, so this is safe to
// mount unconditionally rather than needing its own environment gate.
app.use('/api', devLocalStorageRouter);

app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err, reqId: req.requestId, method: req.method, url: req.originalUrl }, 'unhandled error');
  // { success: false, error } — matching the shape every route in this codebase already uses for
  // its own handled errors (via handleCreateError.ts or an inline res.status(...).json(...)). This
  // used to be a different shape ({ error, requestId }) with no `success` key at all, so a client
  // that checks `body.success === false` to detect failure wouldn't recognize an unhandled 500.
  res.status(500).json({ success: false, error: 'Internal server error', requestId: req.requestId });
});

async function start() {
  try {
    await sequelize.authenticate();
    logger.info('MySQL connected');
  } catch (err) {
    logger.error({ err }, 'Could not connect to MySQL — check DB_HOST/DB_USER/DB_PASSWORD/DB_NAME in .env.');
  }
  try {
    await auditSequelize.authenticate();
    logger.info('Audit DB connection (restricted user) OK');
  } catch (err) {
    logger.error({ err }, 'Could not connect as the restricted audit DB user — check AUDIT_DB_USER/AUDIT_DB_PASSWORD in .env. Bid logging will fail.');
  }
  try {
    await redis.ping();
  } catch (err) {
    logger.error({ err }, 'Could not connect to Redis — check REDIS_HOST/REDIS_PORT/REDIS_PASSWORD in .env. OTP send/verify and the auction PoC will fail.');
  }
  const httpServer = http.createServer(app);
  setupAuctionSocket(httpServer);
  // Self-healing recovery loops for in-process schedulers that would otherwise silently lose their
  // work on a restart — see each function's own comment for exactly what gap it closes.
  startScheduledAuctionActivationLoop();
  startCustodianNotificationCheckLoop();
  startPaymentReconciliationLoop();
  startInvoiceGenerationCheckLoop();
  httpServer.listen(port, () => logger.info({ port }, 'Wattmatch server listening'));
}

start();
