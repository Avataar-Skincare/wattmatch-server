import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { Op } from 'sequelize';
import { z } from 'zod';
import { Organization } from '../models/Organization.js';
import { OrganizationToken } from '../models/OrganizationToken.js';
import { signOrgToken, verifyOrgToken, type OrgTokenPayload } from '../lib/orgAuth.js';
import { hashPassword, verifyPassword, generateOpaqueToken, hashOpaqueToken } from '../lib/passwordAuth.js';
import { sendEmailVerificationEmail, sendPasswordResetEmail } from '../services/email.js';
import { logger } from '../lib/logger.js';

const router = Router();

const MAX_STRING_FIELD_LENGTH = 255;
const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

// Standard mechanism per AUTH_STRATEGY_DECISIONS.md: email + password everywhere, no OTP/TOTP.
// Minimum length is the one policy call made here beyond what the decision doc specifies — long
// enough to rule out trivially weak passwords without imposing composition rules that just push
// people toward predictable substitutions.
const passwordSchema = z.string().min(10, 'password must be at least 10 characters').max(200);

const registerBodySchema = z.object({
  type: z.enum(['buyer', 'generator']),
  name: z.string().trim().min(1, 'name is required').max(MAX_STRING_FIELD_LENGTH),
  contactEmail: z.string().trim().toLowerCase().email('contactEmail must be a valid email').max(MAX_STRING_FIELD_LENGTH),
  contactPhone: z.string().trim().min(1, 'contactPhone is required').max(MAX_STRING_FIELD_LENGTH),
  password: passwordSchema,
  // Generator-only — the matching engine's basis for capacity comparison. Ignored for buyers.
  capacityMw: z.number().positive().optional(),
});

const loginBodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(MAX_STRING_FIELD_LENGTH),
  password: z.string().min(1).max(200),
});

const verifyEmailBodySchema = z.object({
  token: z.string().min(1).max(500),
});

const forgotPasswordBodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(MAX_STRING_FIELD_LENGTH),
});

const resetPasswordBodySchema = z.object({
  token: z.string().min(1).max(500),
  newPassword: passwordSchema,
});

// Every field optional — this is a "fill in whatever's still missing" update, not a full replace.
// Used by both a self-service "edit my profile" action and the account-less enrollment bridge's
// completion prompt (tenders.ts's /enroll route only ever fills in what a Payment record already
// captured, e.g. no capacityMw at all — see that route's own comment).
const updateProfileBodySchema = z.object({
  name: z.string().trim().min(1).max(MAX_STRING_FIELD_LENGTH).optional(),
  contactPhone: z.string().trim().min(1).max(MAX_STRING_FIELD_LENGTH).optional(),
  capacityMw: z.number().positive().optional(),
});

function extractBearerToken(authHeader: string | undefined): string | undefined {
  return authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
}

async function requireOrgAuth(authHeader: string | undefined): Promise<OrgTokenPayload | null> {
  const token = extractBearerToken(authHeader);
  if (!token) return null;
  try {
    return await verifyOrgToken(token);
  } catch {
    return null;
  }
}

const registerLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
// Tight, specifically to blunt credential stuffing — the exact risk AUTH_STRATEGY_DECISIONS.md
// names as newly real once every account type has a persistent reusable secret.
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const tokenRequestLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const tokenConsumeLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

function frontendUrl(path: string): string {
  const origin = process.env.CORS_ORIGIN ?? 'http://localhost:5173';
  return `${origin}${path}`;
}

async function issueToken(organizationId: number, purpose: 'email_verification' | 'password_reset', ttlMs: number) {
  const { token, tokenHash } = generateOpaqueToken();
  await OrganizationToken.create({
    organizationId,
    purpose,
    tokenHash,
    expiresAt: new Date(Date.now() + ttlMs),
  });
  return token;
}

// Registration now requires a password and sends a verification email — see
// AUTH_STRATEGY_DECISIONS.md. Issues the same bearer token shape as before immediately (unverified
// accounts can still act — nothing downstream gates on emailVerified yet; that's a deliberate,
// separate follow-up, not folded into this pass).
router.post('/organizations', registerLimiter, async (req, res, next) => {
  try {
    const parsed = registerBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }
    const { type, name, contactEmail, contactPhone, password, capacityMw } = parsed.data;

    const existing = await Organization.findOne({ where: { contactEmail } });
    if (existing) {
      return res.status(409).json({ success: false, error: 'An organization with this email already exists' });
    }

    const passwordHash = await hashPassword(password);
    const org = await Organization.create({
      type,
      name,
      contactEmail,
      contactPhone,
      passwordHash,
      capacityMw: type === 'generator' && capacityMw !== undefined ? String(capacityMw) : null,
    });

    const verifyToken = await issueToken(org.id, 'email_verification', EMAIL_VERIFICATION_TTL_MS);
    await sendEmailVerificationEmail(contactEmail, frontendUrl(`/verify-email?token=${encodeURIComponent(verifyToken)}`));

    const token = await signOrgToken({ organizationId: org.id, type: org.type });

    logger.info({ reqId: req.requestId, organizationId: org.id, type }, '[ORG] registered');

    res.json({ success: true, organizationId: org.id, token });
  } catch (err) {
    next(err);
  }
});

// Generic invalid-credentials message on every failure path (unknown email, wrong password) —
// deliberately not distinguishing them, per AUTH_STRATEGY_DECISIONS.md's note on avoiding
// user-enumeration via error-message differences.
router.post('/organizations/login', loginLimiter, async (req, res, next) => {
  try {
    const parsed = loginBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Invalid request' });
    }
    const { email, password } = parsed.data;

    const org = await Organization.findOne({ where: { contactEmail: email } });
    if (!org || !org.passwordHash || !(await verifyPassword(org.passwordHash, password))) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const token = await signOrgToken({ organizationId: org.id, type: org.type });

    logger.info({ reqId: req.requestId, organizationId: org.id }, '[ORG] logged in');

    res.json({ success: true, organizationId: org.id, type: org.type, token });
  } catch (err) {
    next(err);
  }
});

router.post('/organizations/verify-email', tokenConsumeLimiter, async (req, res, next) => {
  try {
    const parsed = verifyEmailBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Invalid request' });
    }

    const tokenHash = hashOpaqueToken(parsed.data.token);
    const record = await OrganizationToken.findOne({
      where: { tokenHash, purpose: 'email_verification', usedAt: null, expiresAt: { [Op.gt]: new Date() } },
    });
    if (!record) {
      return res.status(400).json({ success: false, error: 'This verification link is invalid or has expired' });
    }

    await record.update({ usedAt: new Date() });
    await Organization.update({ emailVerified: true, emailVerifiedAt: new Date() }, { where: { id: record.organizationId } });

    logger.info({ reqId: req.requestId, organizationId: record.organizationId }, '[ORG] email verified');

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// Always returns the same generic response whether or not the email exists — otherwise this
// endpoint becomes a free account-existence oracle, one of the specific failure modes
// AUTH_STRATEGY_DECISIONS.md calls out as needing to be avoided, not just password-reset-specific.
router.post('/organizations/forgot-password', tokenRequestLimiter, async (req, res, next) => {
  try {
    const parsed = forgotPasswordBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: 'Invalid request' });
    }

    const org = await Organization.findOne({ where: { contactEmail: parsed.data.email } });
    if (org) {
      const resetToken = await issueToken(org.id, 'password_reset', PASSWORD_RESET_TTL_MS);
      await sendPasswordResetEmail(org.contactEmail, frontendUrl(`/reset-password?token=${encodeURIComponent(resetToken)}`));
      logger.info({ reqId: req.requestId, organizationId: org.id }, '[ORG] password reset requested');
    }

    res.json({ success: true, message: 'If an account exists for that email, a reset link has been sent.' });
  } catch (err) {
    next(err);
  }
});

router.post('/organizations/reset-password', tokenConsumeLimiter, async (req, res, next) => {
  try {
    const parsed = resetPasswordBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }

    const tokenHash = hashOpaqueToken(parsed.data.token);
    const record = await OrganizationToken.findOne({
      where: { tokenHash, purpose: 'password_reset', usedAt: null, expiresAt: { [Op.gt]: new Date() } },
    });
    if (!record) {
      return res.status(400).json({ success: false, error: 'This reset link is invalid or has expired' });
    }

    const passwordHash = await hashPassword(parsed.data.newPassword);
    await Organization.update({ passwordHash }, { where: { id: record.organizationId } });
    await record.update({ usedAt: new Date() });
    // Invalidate any other outstanding reset tokens for this org — a password change should close
    // out every other in-flight reset link, not just the one that was used.
    await OrganizationToken.update(
      { usedAt: new Date() },
      { where: { organizationId: record.organizationId, purpose: 'password_reset', usedAt: null } }
    );

    logger.info({ reqId: req.requestId, organizationId: record.organizationId }, '[ORG] password reset completed');

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// The account-less enrollment bridge (tenders.ts's POST /tenders/:id/enroll) auto-creates a
// generator account from only what a Payment row captured — name, email, phone — with no
// capacityMw at all, which silently means that org can never be picked up by the automated
// matching engine (autoInviteEligibleGenerators requires capacityMw to compare against). This is
// the completion step that closes that gap, and doubles as ordinary self-service profile editing
// for any organization.
router.get('/organizations/me', async (req, res, next) => {
  try {
    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });

    const org = await Organization.findByPk(payload.organizationId);
    if (!org) return res.status(401).json({ success: false, error: 'Unknown organization' });

    res.json({
      success: true,
      organization: {
        id: org.id,
        type: org.type,
        name: org.name,
        contactEmail: org.contactEmail,
        contactPhone: org.contactPhone,
        capacityMw: org.capacityMw,
      },
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/organizations/me', async (req, res, next) => {
  try {
    const payload = await requireOrgAuth(req.headers.authorization);
    if (!payload) return res.status(401).json({ success: false, error: 'Missing or invalid organization token' });

    const parsed = updateProfileBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, error: parsed.error.issues.map((i) => i.message).join('; ') });
    }
    if (parsed.data.capacityMw !== undefined && payload.type !== 'generator') {
      return res.status(400).json({ success: false, error: 'capacityMw only applies to generator organizations' });
    }

    const org = await Organization.findByPk(payload.organizationId);
    if (!org) return res.status(401).json({ success: false, error: 'Unknown organization' });

    await org.update({
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.contactPhone !== undefined ? { contactPhone: parsed.data.contactPhone } : {}),
      ...(parsed.data.capacityMw !== undefined ? { capacityMw: String(parsed.data.capacityMw) } : {}),
    });

    logger.info({ reqId: req.requestId, organizationId: org.id, fields: Object.keys(parsed.data) }, '[ORG] profile updated');

    res.json({
      success: true,
      organization: { id: org.id, type: org.type, name: org.name, contactEmail: org.contactEmail, contactPhone: org.contactPhone, capacityMw: org.capacityMw },
    });
  } catch (err) {
    next(err);
  }
});

export default router;
