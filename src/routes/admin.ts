import { Router } from 'express';
import { CILead } from '../models/CILead.js';
import { GeneratorLead } from '../models/GeneratorLead.js';
import { ContactMessage } from '../models/ContactMessage.js';
import { CIRegistration } from '../models/CIRegistration.js';
import { GeneratorRegistration } from '../models/GeneratorRegistration.js';
import { Organization } from '../models/Organization.js';
import { authRequired } from '../middleware/auth.js';

const router = Router();
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

// Every route here returns raw marketing-lead/registration PII (name, email, phone, company) —
// admin-only, same as every other internal-ops route in this codebase.
router.use(...authRequired('admin'));

function parseLimit(req: import('express').Request): number {
  const raw = Number(req.query.limit);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT;
  return Math.min(raw, MAX_LIMIT);
}

// Previously nothing capped how far back these lists could be paged — only the page SIZE was
// bounded (parseLimit above), so there was no way to ever see past the first MAX_LIMIT rows.
function parseOffset(req: import('express').Request): number {
  const raw = Number(req.query.offset);
  if (!Number.isFinite(raw) || raw < 0) return 0;
  return Math.floor(raw);
}

router.get('/leads/ci', async (req, res, next) => {
  try {
    const rows = await CILead.findAll({ order: [['id', 'DESC']], limit: parseLimit(req), offset: parseOffset(req) });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/leads/generator', async (req, res, next) => {
  try {
    const rows = await GeneratorLead.findAll({ order: [['id', 'DESC']], limit: parseLimit(req), offset: parseOffset(req) });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

router.get('/contact', async (req, res, next) => {
  try {
    const rows = await ContactMessage.findAll({ order: [['id', 'DESC']], limit: parseLimit(req), offset: parseOffset(req) });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Registration rows have no organizationId column of their own (registrations.ts creates/reuses the
// Organization separately, matched by email) — resolved here in one batched lookup so the admin
// "create a tender from this registration" flow (AdminConsolePage.tsx) has a real buyerOrgId to post
// with, instead of every caller re-deriving this same email join itself.
router.get('/registrations/ci', async (req, res, next) => {
  try {
    const rows = await CIRegistration.findAll({ order: [['id', 'DESC']], limit: parseLimit(req), offset: parseOffset(req) });
    const orgs = await Organization.findAll({ where: { contactEmail: [...new Set(rows.map((r) => r.email))] } });
    const orgIdByEmail = new Map(orgs.map((o) => [o.contactEmail, o.id]));
    res.json(rows.map((r) => ({ ...r.toJSON(), buyerOrgId: orgIdByEmail.get(r.email) ?? null })));
  } catch (err) {
    next(err);
  }
});

router.get('/registrations/generator', async (req, res, next) => {
  try {
    const rows = await GeneratorRegistration.findAll({ order: [['id', 'DESC']], limit: parseLimit(req), offset: parseOffset(req) });
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

export default router;
