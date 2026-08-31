import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { logger } from './logger.js';
import { loadRequiredSecret } from './secrets.js';

export interface AuctionTokenPayload {
  auctionId: number;
  participantId: number;
  alias: string;
  jti: string;
}

export function generateJti(): string {
  return crypto.randomBytes(12).toString('hex');
}

// Deliberately a separate secret from any future field-encryption key. Goes through the shared
// secrets abstraction (AWS Secrets Manager in production via AUCTION_JWT_SECRET_ARN, a plain env
// var in local dev) instead of reading process.env directly — loadSecret() caches after the first
// call, so this is cheap to call on every sign/verify rather than needing its own module-level
// caching here too. The insecure fallback stays as a last resort so local dev never hard-fails with
// no secret configured at all, but now warns on every use it's active, not just once at import time.
async function getJwtSecret(): Promise<string> {
  const secret = await loadRequiredSecret('AUCTION_JWT_SECRET', 'AUCTION_JWT_SECRET_ARN');
  if (!secret) {
    logger.warn('AUCTION_JWT_SECRET is not set anywhere — falling back to an insecure dev-only default. Set it before any real test.');
    return 'dev-only-insecure-auction-secret';
  }
  return secret;
}

// jti is generated separately (via generateJti) and stored on AuctionParticipant BEFORE this is
// called, since the token embeds the participant's DB id — created first, jti reused when signing.
// Default 24h expiry is the legacy shape (auctionAdmin.ts's manual /auctions/seed route, which embeds
// this token directly in an emailed link with no login to fall back on if it expires). The real
// production join path (routes/auctions.ts) passes a much shorter explicit value — that path re-mints
// a fresh token from an org login on every join/reconnect (see AuctionLivePage.tsx), so there's no
// reason for its tokens to outlive a single sitting; a leaked one's replay window shrinks accordingly.
export async function signJoinToken(
  payload: AuctionTokenPayload,
  expiresIn: jwt.SignOptions['expiresIn'] = '24h'
): Promise<string> {
  const secret = await getJwtSecret();
  return jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn });
}

// Always strict on expiry now — the one caller that used to need ignoreExpiration (winner-identity,
// reachable days after a 24h token's natural expiry) now authenticates via the org's durable login
// session instead of reusing this ephemeral socket token at all (see routes/auctions.ts), so there's
// no remaining case where an expired-but-genuine token should still be accepted.
export async function verifyJoinToken(token: string): Promise<AuctionTokenPayload> {
  const secret = await getJwtSecret();
  return jwt.verify(token, secret) as AuctionTokenPayload;
}

// Loads the same way as the JWT secret (AWS Secrets Manager in production, plain env var in local
// dev) rather than reading process.env directly — see secrets.ts.
async function getIpHashSecret(): Promise<string> {
  const secret = await loadRequiredSecret('IP_HASH_HMAC_SECRET', 'IP_HASH_HMAC_SECRET_ARN');
  if (!secret) {
    logger.warn('IP_HASH_HMAC_SECRET is not set — falling back to an insecure dev-only default. Set it before any real test.');
    return 'dev-only-insecure-ip-hash-secret';
  }
  return secret;
}

export async function hashIp(ip: string | undefined): Promise<string | null> {
  if (!ip) return null;
  // The same physical client can show up as "127.0.0.1" on one connection and the IPv4-mapped
  // IPv6 form "::ffff:127.0.0.1" on another, depending on the transport/proxy path — hashing them
  // as-is would produce two different hashes for one real IP, causing the collusion detector's
  // "shared IP across aliases" check (auctionEngine.ts) to miss an actual match rather than
  // false-flag one. Normalizing to the plain IPv4 form first keeps the hash consistent.
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  // HMAC with a secret key, not a bare hash — an IPv4 address has only ~4.3 billion possible
  // values, small enough that a plain SHA-256(ip) is fully reversible via a precomputed rainbow
  // table (trivial to build on modern hardware). That would make this "pseudonymized" value not
  // actually protected against reversal at all — exactly the kind of hole this is meant to close.
  // Keying it with a secret only this server knows means reversing it requires brute-forcing the
  // secret itself, not just the small IP space.
  const secret = await getIpHashSecret();
  return crypto.createHmac('sha256', secret).update(normalized).digest('hex');
}
