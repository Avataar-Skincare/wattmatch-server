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
export function signJoinToken(payload: AuctionTokenPayload): string {
  return jwt.sign(payload, SECRET, { algorithm: 'HS256' });
}

export function verifyJoinToken(token: string): AuctionTokenPayload {
  // Throws on invalid/expired/tampered tokens — callers must catch and reject the connection.
  return jwt.verify(token, SECRET) as AuctionTokenPayload;
}

export function hashIp(ip: string | undefined): string | null {
  if (!ip) return null;
  return crypto.createHash('sha256').update(ip).digest('hex');
}
