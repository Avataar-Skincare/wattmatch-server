import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { sequelize } from './db/sequelize.js';
import { auditSequelize } from './db/auditSequelize.js';
import { redis } from './lib/redis.js';
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
    console.log(`[${new Date().toISOString()}] [req=${req.requestId}] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
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
  console.error(`[${new Date().toISOString()}] [req=${req.requestId}] Unhandled error on ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
});

async function start() {
  try {
    await sequelize.authenticate();
    console.log('MySQL connected');
  } catch (err) {
    console.error('Could not connect to MySQL — check DB_HOST/DB_USER/DB_PASSWORD/DB_NAME in .env.', err);
  }
  try {
    await auditSequelize.authenticate();
    console.log('Audit DB connection (restricted user) OK');
  } catch (err) {
    console.error('Could not connect as the restricted audit DB user — check AUDIT_DB_USER/AUDIT_DB_PASSWORD in .env. Bid logging will fail.', err);
  }
  try {
    await redis.ping();
  } catch (err) {
    console.error('Could not connect to Redis — check REDIS_HOST/REDIS_PORT/REDIS_PASSWORD in .env. OTP send/verify and the auction PoC will fail.', err);
  }
  const httpServer = http.createServer(app);
  setupAuctionSocket(httpServer);
  httpServer.listen(port, () => console.log(`Wattmatch server listening on port ${port}`));
}

start();
