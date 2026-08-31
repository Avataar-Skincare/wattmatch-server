import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { verifyOrgToken } from '../lib/orgAuth.js';
import { Organization, type OrganizationType } from '../models/Organization.js';

// The single auth check every route in this codebase should use — replaces the extractBearerToken
// + requireOrgAuth pair that used to be hand-copied into six different route files. Re-fetches the
// Organization row on every request (rather than trusting the JWT payload alone for up to its full
// 12h life) so a deleted org or one whose type changed loses access immediately, not up to 12h
// later — the JWT proves who *signed in*, this confirms they still are who they claim to be *now*.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      org?: {
        id: number;
        type: OrganizationType;
        name: string;
        contactEmail: string;
        contactPhone: string;
        capacityMw: string | null;
      };
    }
  }
}

// Exported — routes/auctions.ts's winner-identity needs to try this token as one of two possible
// credential types (org session vs. legacy auction join token), so it can't go through the
// all-or-nothing requireAuth/optionalAuth below.
export function extractBearerToken(authHeader: string | undefined): string | undefined {
  return authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;
}

// Shared resolution behind both requireAuth and optionalAuth below — verifies the token and
// re-fetches the Organization row (rather than trusting the JWT payload alone for up to its full
// 12h life) so a deleted org or one whose type changed loses access immediately, not up to 12h
// later. Returns null on ANY failure (missing token, invalid/expired signature, deleted org, type
// mismatch) without distinguishing which — callers that need to 401 do so uniformly, and callers
// that treat auth as optional simply proceed unauthenticated.
async function resolveOrg(authHeader: string | undefined): Promise<Request['org'] | null> {
  const token = extractBearerToken(authHeader);
  if (!token) return null;

  let payload;
  try {
    payload = await verifyOrgToken(token);
  } catch {
    return null;
  }

  const org = await Organization.findByPk(payload.organizationId);
  // The type mismatch check matters even though payload.type came from a signature just verified
  // above — an org's type can change after the token was issued (not something this app does
  // today, but nothing prevents it), and a stale 'admin' claim on a demoted org must not survive
  // until the token's natural expiry.
  if (!org || org.type !== payload.type) return null;

  return {
    id: org.id,
    type: org.type,
    name: org.name,
    contactEmail: org.contactEmail,
    contactPhone: org.contactPhone,
    capacityMw: org.capacityMw,
  };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const org = await resolveOrg(req.headers.authorization);
  if (!org) {
    res.status(401).json({ success: false, error: 'Missing or invalid organization token' });
    return;
  }
  req.org = org;
  next();
}

// For routes with a dual public/authenticated path (e.g. "use your logged-in email, or supply one
// explicitly") — attaches req.org when a valid token is present, but never rejects the request for
// having none or an invalid one. The handler itself decides what to do in either case.
export async function optionalAuth(req: Request, _res: Response, next: NextFunction): Promise<void> {
  req.org = (await resolveOrg(req.headers.authorization)) ?? undefined;
  next();
}

export function requireRole(...types: OrganizationType[]): RequestHandler {
  return (req, res, next) => {
    if (!req.org) {
      res.status(401).json({ success: false, error: 'Missing or invalid organization token' });
      return;
    }
    if (!types.includes(req.org.type)) {
      res.status(403).json({ success: false, error: `Only ${types.join('/')} organizations can access this` });
      return;
    }
    next();
  };
}

// Convenience composition: authRequired() is just requireAuth; authRequired('admin', 'buyer')
// additionally restricts to those roles. Use as router.get('/x', ...authRequired('admin'), handler).
export function authRequired(...roles: OrganizationType[]): RequestHandler[] {
  return roles.length ? [requireAuth, requireRole(...roles)] : [requireAuth];
}
