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
import { setupAuctionSocket } from './sockets/auctionSocket.js';

const app = express();
const port = process.env.PORT ?? 4000;

app.use(cors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173' }));
app.use(express.json());

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
