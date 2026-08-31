import { describe, it, expect, vi } from 'vitest';
import { signJoinToken, verifyJoinToken, generateJti, hashIp } from './auctionTokens.js';

describe('generateJti', () => {
  it('produces distinct values on repeated calls', () => {
    const a = generateJti();
    const b = generateJti();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]+$/);
  });
});

describe('signJoinToken / verifyJoinToken', () => {
  it('round-trips a payload through sign then verify', async () => {
    const payload = { auctionId: 1, participantId: 2, alias: 'GEN-A', jti: generateJti() };
    const token = await signJoinToken(payload);
    const decoded = await verifyJoinToken(token);
    expect(decoded.auctionId).toBe(payload.auctionId);
    expect(decoded.participantId).toBe(payload.participantId);
    expect(decoded.alias).toBe(payload.alias);
    expect(decoded.jti).toBe(payload.jti);
  });

  it('rejects a tampered token', async () => {
    const token = await signJoinToken({ auctionId: 1, participantId: 2, alias: 'GEN-A', jti: generateJti() });
    const tampered = token.slice(0, -4) + 'XXXX';
    await expect(verifyJoinToken(tampered)).rejects.toThrow();
  });

  it('rejects a garbage string outright', async () => {
    await expect(verifyJoinToken('not-a-real-token')).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    vi.useFakeTimers();
    try {
      const token = await signJoinToken({ auctionId: 1, participantId: 2, alias: 'GEN-A', jti: generateJti() });
      vi.advanceTimersByTime(25 * 60 * 60 * 1000); // 25h — past the default 24h expiry
      await expect(verifyJoinToken(token)).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors an explicit shorter expiresIn', async () => {
    vi.useFakeTimers();
    try {
      const token = await signJoinToken({ auctionId: 1, participantId: 2, alias: 'GEN-A', jti: generateJti() }, '1h');
      vi.advanceTimersByTime(90 * 60 * 1000); // 90min — past the 1h expiry
      await expect(verifyJoinToken(token)).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('hashIp', () => {
  it('returns null for an undefined address', async () => {
    expect(await hashIp(undefined)).toBeNull();
  });

  it('produces the same hash for a plain IPv4 and its IPv4-mapped IPv6 form', async () => {
    // This normalization exists specifically so the collusion detector's "shared IP across
    // aliases" check isn't fooled by the same physical client showing up differently depending on
    // the transport/proxy path — a real bug this session's work fixed.
    const plain = await hashIp('127.0.0.1');
    const mapped = await hashIp('::ffff:127.0.0.1');
    expect(plain).toBe(mapped);
  });

  it('produces different hashes for genuinely different IPs', async () => {
    expect(await hashIp('127.0.0.1')).not.toBe(await hashIp('127.0.0.2'));
  });

  it('is deterministic for the same input', async () => {
    expect(await hashIp('10.0.0.5')).toBe(await hashIp('10.0.0.5'));
  });

  it('is not reversible by brute-forcing the small IPv4 space with a bare hash', async () => {
    // The whole point of the HMAC fix: hashing every possible IPv4 octet combination with plain
    // SHA-256 would eventually match a leaked hash (the space is only ~4.3 billion values, trivial
    // to precompute). Confirms the output is NOT equal to a bare SHA-256 of the same input, which
    // would be reversible that way — it must depend on a secret the attacker doesn't have.
    const crypto = await import('node:crypto');
    const bareHash = crypto.createHash('sha256').update('203.0.113.7').digest('hex');
    expect(await hashIp('203.0.113.7')).not.toBe(bareHash);
  });
});
