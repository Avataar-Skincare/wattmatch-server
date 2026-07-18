import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { sequelize } from './db/sequelize.js';
import leadsRouter from './routes/leads.js';
import contactRouter from './routes/contact.js';

const app = express();
const port = process.env.PORT ?? 4000;

app.use(cors({ origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173' }));
app.use(express.json());

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/leads', leadsRouter);
app.use('/api/contact', contactRouter);

app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(`[${new Date().toISOString()}] Unhandled error on ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({ error: 'Internal server error' });
});

async function start() {
  try {
    await sequelize.authenticate();
    console.log('MySQL connected');
  } catch (err) {
    console.error('Could not connect to MySQL — check DB_HOST/DB_USER/DB_PASSWORD/DB_NAME in .env.', err);
  }
  app.listen(port, () => console.log(`Wattmatch server listening on port ${port}`));
}

start();
