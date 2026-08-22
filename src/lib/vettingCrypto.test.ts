import { describe, it, expect } from 'vitest';
import {
  generateVettingKeypair,
  reconstructPrivateKey,
  sealPayload,
  openEnvelope,
  shareChecksum,
  fingerprintPublicKey,
} from './vettingCrypto.js';

describe('vettingCrypto', () => {
  it('round-trips a sealed payload through any 2-of-3 share combination', async () => {
    const { publicKeyPem, fingerprint, shares } = await generateVettingKeypair();
    const sealed = sealPayload(publicKeyPem, JSON.stringify({ capacity: '5MW', tariff: 6.2 }));

    const pairs = [
      [shares[0], shares[1]],
      [shares[0], shares[2]],
      [shares[1], shares[2]],
    ];
    for (const pair of pairs) {
      const privateKey = await reconstructPrivateKey(pair, fingerprint);
      const opened = openEnvelope(privateKey, sealed);
      expect(JSON.parse(opened)).toEqual({ capacity: '5MW', tariff: 6.2 });
    }
  });

  it('rejects reconstruction with only a single share', async () => {
    const { shares } = await generateVettingKeypair();
    await expect(reconstructPrivateKey([shares[0]], 'irrelevant')).rejects.toThrow(/at least 2/i);
  });

  it('rejects a share from a different keypair via the fingerprint check, not a silent garbage decrypt', async () => {
    const keyA = await generateVettingKeypair();
    const keyB = await generateVettingKeypair();
    // Mix one real share from A with one real share from B — neither a valid 2-of-3 for either key.
    await expect(reconstructPrivateKey([keyA.shares[0], keyB.shares[0]], keyA.fingerprint)).rejects.toThrow();
  });

  it('rejects reconstruction when the fingerprint does not match (wrong expected value)', async () => {
    const { shares } = await generateVettingKeypair();
    const other = await generateVettingKeypair();
    await expect(reconstructPrivateKey([shares[0], shares[1]], other.fingerprint)).rejects.toThrow(
      /does not match the expected fingerprint/
    );
  });

  it('fails cleanly on a tampered ciphertext (GCM auth tag catches it)', async () => {
    const { publicKeyPem, fingerprint, shares } = await generateVettingKeypair();
    const sealed = sealPayload(publicKeyPem, 'sensitive bid content');
    const tampered = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext, 'base64').map((b, i) => (i === 0 ? b ^ 0xff : b)) };
    const tamperedBase64 = { ...sealed, ciphertext: Buffer.from(tampered.ciphertext).toString('base64') };
    const privateKey = await reconstructPrivateKey([shares[0], shares[1]], fingerprint);
    expect(() => openEnvelope(privateKey, tamperedBase64)).toThrow();
  });

  it('produces a verifiable share checksum independent of the private key', async () => {
    const { shares, shareChecksums } = await generateVettingKeypair();
    expect(shareChecksum(shares[0])).toBe(shareChecksums[0]);
    expect(shareChecksum(shares[0])).not.toBe(shareChecksum(shares[1]));
  });

  it('fingerprintPublicKey is deterministic for the same key', async () => {
    const { publicKeyPem, fingerprint } = await generateVettingKeypair();
    expect(fingerprintPublicKey(publicKeyPem)).toBe(fingerprint);
  });
});
