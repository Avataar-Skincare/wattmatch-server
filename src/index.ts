import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
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
import auctionAdminRouter from './routes/auctionAdmin.js';
import vettingBidsRouter from './routes/vettingBids.js';
import vettingAuctionBridgeRouter from './routes/vettingAuctionBridge.js';
import organizationsRouter from './routes/organizations.js';
import tendersRouter from './routes/tenders.js';
import tenderDocumentsRouter from './routes/tenderDocuments.js';
import paymentsRouter from './routes/payments.js';
import devLocalStorageRouter from './routes/devLocalStorage.js';
import { setupAuctionSocket } from './sockets/auctionSocket.js';

const app = express();
const port = process.env.PORT ?? 4000;

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

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/leads', leadsRouter);
app.use('/api/contact', contactRouter);
app.use('/api/admin', adminRouter);
// app.use('/api/otp', otpRouter);
app.use('/api/registrations', registrationsRouter);
// PoC-only: reverse-auction MVP, see AUCTION_MVP_PLAN.md. No auth on the seed route by design —
// stands in for the real enrollment flow, not meant to ship as-is.
app.use('/api/auction-admin', auctionAdminRouter);
// Sealed technical + financial bid module (pre-auction stage) — see
// VETTING_BID_SEALING_IMPLEMENTATION_PLAN.md. No auth yet, same as the routes above; the one
// route holding settled bid content (/decided-record) is specifically planned for email+password
// login before any real data flows through it — see AUTH_STRATEGY_DECISIONS.md.
app.use('/api', vettingBidsRouter);
// Vetting -> live auction bridge — see VETTING_TO_AUCTION_BRIDGE_PLAN.md. Deliberately does not
// share code with auctionAdmin.ts's seed route (see that route's own comment) to avoid touching
// tested, demo-critical code.
app.use('/api', vettingAuctionBridgeRouter);
// Minimal buyer/generator registration + tender posting/matching — see
// MINIMAL_PIPELINE_INTEGRATION_PLAN.md. Placeholder auth (orgAuth.ts), not the real
// email+password login decided in AUTH_STRATEGY_DECISIONS.md.
app.use('/api', organizationsRouter);
app.use('/api', tendersRouter);
// Stage 6.1/6.2/6.3's document checklist — see TENDER_WORKFLOW_STAKEHOLDER_PLAN.md.
app.use('/api', tenderDocumentsRouter);
// Razorpay order creation — see TENDER_WORKFLOW_STAKEHOLDER_PLAN.md's Payment & EMD section.
app.use('/api', paymentsRouter);
// Dev-only stand-in for S3 signed-URL downloads when AWS_S3_BUCKET isn't configured — see
// lib/s3.ts. Always inert (404s everything) once a real bucket is configured, so this is safe to
// mount unconditionally rather than needing its own environment gate.
app.use('/api', devLocalStorageRouter);

app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err, reqId: req.requestId, method: req.method, url: req.originalUrl }, 'unhandled error');
  res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
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
  httpServer.listen(port, () => logger.info({ port }, 'Wattmatch server listening'));
}

start();
