import jwt from 'jsonwebtoken';
import { logger } from './logger.js';
import { loadSecret } from './secrets.js';
import type { OrganizationType } from '../models/Organization.js';

// Placeholder identity token for the minimal pipeline-integration pass — see
// MINIMAL_PIPELINE_INTEGRATION_PLAN.md and AUTH_STRATEGY_DECISIONS.md. This is NOT the real login
// mechanism (email+password, now decided) — it issues a token the same *shape* real login will
// eventually produce, so nothing downstream that consumes it needs to change when real
// password/hashing/reset machinery replaces this. Mirrors auctionTokens.ts's secret-loading and
// signing pattern exactly, for consistency, not because this is the same trust boundary.

export interface OrgTokenPayload {
  organizationId: number;
  type: OrganizationType;
}

async function getOrgJwtSecret(): Promise<string> {
  const secret = await loadSecret('ORG_JWT_SECRET', 'ORG_JWT_SECRET_ARN');
  if (!secret) {
    logger.warn('ORG_JWT_SECRET is not set anywhere — falling back to an insecure dev-only default. Set it before any real test.');
    return 'dev-only-insecure-org-secret';
  }
  return secret;
}

export async function signOrgToken(payload: OrgTokenPayload): Promise<string> {
  const secret = await getOrgJwtSecret();
  return jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn: '24h' });
}

export async function verifyOrgToken(token: string): Promise<OrgTokenPayload> {
  const secret = await getOrgJwtSecret();
  return jwt.verify(token, secret) as OrgTokenPayload;
}
