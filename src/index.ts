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

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/leads', leadsRouter);
app.use('/api/contact', contactRouter);

async function start() {
  try {
    await sequelize.authenticate();
    console.log('MySQL connected');
  } catch (err) {
    console.warn('Could not connect to MySQL — check DB_HOST/DB_USER/DB_PASSWORD/DB_NAME in .env.', err);
  }
  app.listen(port, () => console.log(`Wattmatch server listening on port ${port}`));
}

start();
