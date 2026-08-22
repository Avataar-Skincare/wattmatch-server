import argon2 from 'argon2';
import crypto from 'node:crypto';

// Standard-mechanism auth building blocks — see AUTH_STRATEGY_DECISIONS.md: email+password
// everywhere, Argon2id hashing, opaque high-entropy tokens for reset/verification links (never
// hand-rolled crypto). Argon2id's own defaults (64MB memory, 3 passes) already exceed the spirit of
// the decision's "cost >= 12" bcrypt-era bar, so they're used as-is rather than hand-tuned.

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

// One-time opaque tokens for email verification / password reset. Only the SHA-256 hash is ever
// stored — same reasoning as vettingCrypto.ts's shareChecksum: the raw token is high-entropy and
// unguessable, so publishing/storing its hash for later comparison reveals nothing, while a leaked
// database dump can't be used to forge a valid token.
export function generateOpaqueToken(): { token: string; tokenHash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, tokenHash };
}

export function hashOpaqueToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
