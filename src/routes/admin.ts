import { Router } from 'express';
import { CILead } from '../models/CILead.js';
import { GeneratorLead } from '../models/GeneratorLead.js';
import { ContactMessage } from '../models/ContactMessage.js';
import { CIRegistration } from '../models/CIRegistration.js';
import { GeneratorRegistration } from '../models/GeneratorRegistration.js';

const router = Router();
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function parseLimit(req: import('express').Request): number {
  const raw = Number(req.query.limit);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT;
  return Math.min(raw, MAX_LIMIT);
}

router.get('/leads/ci', async (req, res) => {
  const rows = await CILead.findAll({ order: [['id', 'DESC']], limit: parseLimit(req) });
  res.json(rows);
});

router.get('/leads/generator', async (req, res) => {
  const rows = await GeneratorLead.findAll({ order: [['id', 'DESC']], limit: parseLimit(req) });
  res.json(rows);
});

router.get('/contact', async (req, res) => {
  const rows = await ContactMessage.findAll({ order: [['id', 'DESC']], limit: parseLimit(req) });
  res.json(rows);
});

router.get('/registrations/ci', async (req, res) => {
  const rows = await CIRegistration.findAll({ order: [['id', 'DESC']], limit: parseLimit(req) });
  res.json(rows);
});

router.get('/registrations/generator', async (req, res) => {
  const rows = await GeneratorRegistration.findAll({ order: [['id', 'DESC']], limit: parseLimit(req) });
  res.json(rows);
});

export default router;
