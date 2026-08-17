import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encryptField, decryptField } from './fieldEncryption.js';

// No FIELD_ENCRYPTION_KMS_KEY_ID is set in the test environment, so these exercise the local
// AES-256-GCM path exclusively — the KMS path is a thin, directly-typed wrapper around the AWS SDK
// call and isn't worth mocking here.
describe('fieldEncryption (local scheme)', () => {
  const originalKey = process.env.FIELD_ENCRYPTION_KEY;

  afterEach(() => {
    if (originalKey === undefined) delete process.env.FIELD_ENCRYPTION_KEY;
    else process.env.FIELD_ENCRYPTION_KEY = originalKey;
  });

  it('round-trips a plaintext value', async () => {
    const ciphertext = await encryptField('Demo Generator One');
    expect(ciphertext).toMatch(/^local:/);
    expect(ciphertext).not.toContain('Demo Generator One');
    expect(await decryptField(ciphertext)).toBe('Demo Generator One');
  });

  it('produces different ciphertext for the same plaintext on repeated calls (random IV)', async () => {
    const a = await encryptField('Same Name Inc');
    const b = await encryptField('Same Name Inc');
    expect(a).not.toBe(b);
    expect(await decryptField(a)).toBe('Same Name Inc');
    expect(await decryptField(b)).toBe('Same Name Inc');
  });

  it('handles an empty string', async () => {
    const ciphertext = await encryptField('');
    expect(await decryptField(ciphertext)).toBe('');
  });

  it('rejects a value with no recognized scheme prefix rather than guessing', async () => {
    await expect(decryptField('plain-old-unencrypted-name')).rejects.toThrow(/unrecognized encryption scheme/);
    await expect(decryptField('')).rejects.toThrow(/unrecognized encryption scheme/);
  });

  it('fails to decrypt a value tampered with after encryption (GCM auth tag catches it)', async () => {
    const ciphertext = await encryptField('Tamper Test Co');
    const [scheme, body] = ciphertext.split(':');
    const bytes = Buffer.from(body, 'base64');
    bytes[bytes.length - 1] ^= 0xff; // flip a bit in the ciphertext tail
    const tampered = `${scheme}:${bytes.toString('base64')}`;
    await expect(decryptField(tampered)).rejects.toThrow();
  });

  describe('key isolation between environments', () => {
    beforeEach(() => {
      process.env.FIELD_ENCRYPTION_KEY = 'key-A';
    });

    it('cannot be decrypted under a different configured key, with an actionable error rather than a raw crypto error', async () => {
      const ciphertext = await encryptField('Cross-Key Co');
      process.env.FIELD_ENCRYPTION_KEY = 'key-B';
      // A wrong key must fail decryption cleanly (GCM tag mismatch), never silently return garbage
      // as if it were the real plaintext — the same property relied on for the tamper test above.
      // The message itself matters here, not just that it throws: a key mismatch is otherwise a
      // real dead end (this scheme has no key-versioning) — without a clear message pointing at
      // "the key changed," it's an opaque OpenSSL error nobody would know how to diagnose.
      await expect(decryptField(ciphertext)).rejects.toThrow(/the key has changed/);
    });
  });
});
