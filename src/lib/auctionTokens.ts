import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

// PoC-scope secret handling: an env var, never hardcoded/committed. A dedicated secrets manager
// (AWS Secrets Manager/Vault) is deferred until this runs anywhere testers don't fully trust —
// see AUCTION_MVP_PLAN.md. Deliberately a separate secret from any future field-encryption key.
const JWT_SECRET = process.env.AUCTION_JWT_SECRET;
if (!JWT_SECRET) {
  console.warn(
    'AUCTION_JWT_SECRET is not set — falling back to an insecure dev-only default. Set it in .env before any real test.'
  );
}
const SECRET = JWT_SECRET || 'dev-only-insecure-auction-secret';

export interface AuctionTokenPayload {
  auctionId: number;
  participantId: number;
  alias: string;
  jti: string;
}

export function generateJti(): string {
  return crypto.randomBytes(12).toString('hex');
}

// jti is generated separately (via generateJti) and stored on AuctionParticipant BEFORE this is
// called, since the token embeds the participant's DB id — created first, jti reused when signing.
// 24h expiry — generous relative to how long a PoC auction actually runs (minutes, even with
// extensions), but bounded rather than forever: previously this had no expiresIn at all, so a
// leaked join link worked indefinitely despite verifyJoinToken's own comment claiming otherwise.
export function signJoinToken(payload: AuctionTokenPayload): string {
  return jwt.sign(payload, SECRET, { algorithm: 'HS256', expiresIn: '24h' });
}

export function verifyJoinToken(token: string): AuctionTokenPayload {
  // Throws on invalid/expired/tampered tokens — callers must catch and reject the connection.
  return jwt.verify(token, SECRET) as AuctionTokenPayload;
}

export function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  // The same physical client can show up as "127.0.0.1" on one connection and the IPv4-mapped
  // IPv6 form "::ffff:127.0.0.1" on another, depending on the transport/proxy path — hashing them
  // as-is would produce two different hashes for one real IP, causing the collusion detector's
  // "shared IP across aliases" check (auctionEngine.ts) to miss an actual match rather than
  // false-flag one. Normalizing to the plain IPv4 form first keeps the hash consistent.
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}
