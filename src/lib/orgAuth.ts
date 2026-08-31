import jwt from 'jsonwebtoken';
import { logger } from './logger.js';
import { loadRequiredSecret } from './secrets.js';
import type { OrganizationType } from '../models/Organization.js';

// The real session mechanism for every org login (buyer/generator/admin) — email+password via
// passwordAuth.ts issues this same token shape. See middleware/auth.ts for the single place every
// route enforces it.

export interface OrgTokenPayload {
  organizationId: number;
  type: OrganizationType;
}

// loadRequiredSecret throws in production if neither ORG_JWT_SECRET nor ORG_JWT_SECRET_ARN is
// configured — a deploy with no real secret set refuses to boot rather than silently signing and
// accepting tokens (including forgeable admin tokens) under a hardcoded default published in this
// repo's own source. Outside production the insecure default keeps local dev working with zero setup.
async function getOrgJwtSecret(): Promise<string> {
  const secret = await loadRequiredSecret('ORG_JWT_SECRET', 'ORG_JWT_SECRET_ARN');
  if (!secret) {
    logger.warn('ORG_JWT_SECRET is not set anywhere — falling back to an insecure dev-only default. Set it before any real test.');
    return 'dev-only-insecure-org-secret';
  }
  return secret;
}

// 12h — halves the exposure window of a leaked token versus the previous 24h. No refresh-token
// flow: a session just expires and the org logs in again, same as today.
export async function signOrgToken(payload: OrgTokenPayload): Promise<string> {
  const secret = await getOrgJwtSecret();
  return jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn: '12h' });
}

export async function verifyOrgToken(token: string): Promise<OrgTokenPayload> {
  const secret = await getOrgJwtSecret();
  return jwt.verify(token, secret) as OrgTokenPayload;
}
