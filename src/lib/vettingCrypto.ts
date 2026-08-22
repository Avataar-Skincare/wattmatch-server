import crypto from 'node:crypto';
import { split, combine } from 'shamir-secret-sharing';

// Core primitives for the sealed technical + financial bid module — see
// VETTING_BID_SEALING_IMPLEMENTATION_PLAN.md for the full design. This is NOT the live auction's
// encryption (that module has nothing to seal — its price is deliberately public in real time).
// This protects a genuinely different thing: a generator's technical qualification and price bid,
// which must stay unreadable — including to Wattmatch's own admins and developers — until a
// 2-of-3 custodian ceremony legitimately opens it.
//
// Uses `shamir-secret-sharing` (Apache-2.0, zero dependencies, independently audited, published by
// Privy) rather than hand-rolled threshold cryptography — matches this project's standing
// principle of assembling standard, managed primitives rather than designing crypto from scratch.

const CUSTODIAN_COUNT = 3;
const CUSTODIAN_THRESHOLD = 2;
const RSA_MODULUS_LENGTH = 3072;
const OAEP_HASH = 'sha256';

export interface GeneratedKeypair {
  publicKeyPem: string;
  fingerprint: string;
  shares: Uint8Array[];
  shareChecksums: string[];
}

// SHA-256 of a share's bytes — safe to record and hand back to a custodian for self-verification.
// This does not weaken the scheme: a share is high-entropy random-looking data, not a guessable
// value, so publishing its checksum is the same safe pattern as publishing a software download's
// checksum — it lets a custodian confirm their copy is intact without exposing anything about the
// underlying key, and without needing the private key or any other custodian to check.
export function shareChecksum(share: Uint8Array): string {
  return crypto.createHash('sha256').update(share).digest('hex');
}

// SHA-256 of the public key's SPKI DER encoding — this is the integrity check that turns "wrong or
// foreign share supplied during a ceremony" into a clean, explicit rejection instead of silently
// producing garbage plaintext from an incorrectly reconstructed key.
export function fingerprintPublicKey(publicKeyPem: string): string {
  const keyObject = crypto.createPublicKey(publicKeyPem);
  const der = keyObject.export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex');
}

// Generates one RSA keypair and splits its private key into CUSTODIAN_COUNT shares, any
// CUSTODIAN_THRESHOLD of which reconstruct it. The raw private key exists only in this function's
// local scope — it is never written to disk, logged, or returned to the caller in any form other
// than already-split shares. Called once per key type (technical, financial) by
// scripts/generate-vetting-keypairs.mjs, and again by scripts/regenerate-vetting-key.mjs for the
// compromise-only true-regeneration path.
export async function generateVettingKeypair(): Promise<GeneratedKeypair> {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: RSA_MODULUS_LENGTH,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  const shares = await split(new Uint8Array(privateKey), CUSTODIAN_COUNT, CUSTODIAN_THRESHOLD);
  const fingerprint = fingerprintPublicKey(publicKey);
  const shareChecksums = shares.map(shareChecksum);

  return { publicKeyPem: publicKey, fingerprint, shares, shareChecksums };
}

// The routine custodian-succession path (see the plan's "Key lifecycle" section): reconstructs the
// existing key from any two of its current shares, then re-splits it into a fresh set of three —
// the underlying keypair never changes, so everything ever sealed under it stays openable. Used by
// scripts/reshare-vetting-key.mjs.
export async function resharePrivateKey(shares: Uint8Array[]): Promise<Uint8Array[]> {
  const privateKeyDer = await combine(shares);
  return split(privateKeyDer, CUSTODIAN_COUNT, CUSTODIAN_THRESHOLD);
}

// Combines any two-of-three shares and verifies the result against the fingerprint recorded at
// generation time — a wrong, foreign, or corrupted share reconstructs to garbage bytes that either
// fail to parse as a valid PKCS8 key, or (in the astronomically unlikely case they do parse)
// produce a public key whose fingerprint won't match. Either way this throws a clear, specific
// error rather than silently returning something that looks plausible.
export async function reconstructPrivateKey(
  shares: Uint8Array[],
  expectedFingerprint: string
): Promise<crypto.KeyObject> {
  if (shares.length < CUSTODIAN_THRESHOLD) {
    throw new Error(`At least ${CUSTODIAN_THRESHOLD} custodian shares are required — received ${shares.length}`);
  }

  const privateKeyDer = await combine(shares);

  let keyObject: crypto.KeyObject;
  try {
    keyObject = crypto.createPrivateKey({ key: Buffer.from(privateKeyDer), format: 'der', type: 'pkcs8' });
  } catch (err) {
    throw new Error(
      'Failed to reconstruct a valid private key from the supplied shares — this means at least one share is wrong, corrupted, or from a different key. Original error: ' +
        (err instanceof Error ? err.message : String(err))
    );
  }

  const publicKeyPem = crypto.createPublicKey(keyObject).export({ type: 'spki', format: 'pem' }) as string;
  const actualFingerprint = fingerprintPublicKey(publicKeyPem);
  if (actualFingerprint !== expectedFingerprint) {
    throw new Error(
      'Reconstructed key does not match the expected fingerprint — at least one supplied share is wrong, corrupted, or belongs to a different key. Refusing to proceed.'
    );
  }

  return keyObject;
}

export interface SealedEnvelope {
  // Base64, RSA-OAEP-SHA256-wrapped AES-256 data key.
  wrappedDataKey: string;
  // Base64, 12 bytes.
  iv: string;
  // Base64 — AES-256-GCM ciphertext with the 16-byte auth tag concatenated at the end, matching
  // the Web Crypto API's native output shape so browser and Node code share one wire format.
  ciphertext: string;
}

// Server-side reference implementation of the sealing operation — exists so this module is
// directly testable without a browser, and so the browser-side contract below is proven correct
// against the same reconstruct/decrypt path a real ceremony uses. A real submission form seals
// client-side using the Web Crypto API equivalent of exactly this:
//
//   const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
//   const iv = crypto.getRandomValues(new Uint8Array(12));
//   const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dataKey, payloadBytes);
//   const rawDataKey = await crypto.subtle.exportKey('raw', dataKey);
//   const publicKey = await crypto.subtle.importKey('spki', publicKeyDer, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
//   const wrappedDataKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, publicKey, rawDataKey);
//
// `ciphertext` here already includes the GCM tag (Web Crypto's `encrypt` output does too) — no
// separate tag field needed on either side.
export function sealPayload(publicKeyPem: string, payload: string): SealedEnvelope {
  const dataKey = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ciphertext = Buffer.concat([encrypted, tag]);

  const publicKey = crypto.createPublicKey(publicKeyPem);
  const wrappedDataKey = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: OAEP_HASH },
    dataKey
  );

  return {
    wrappedDataKey: wrappedDataKey.toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

// The other half of a ceremony: given the reconstructed private key, unwrap and decrypt one
// envelope. Throws cleanly (GCM auth tag mismatch) if the ciphertext was tampered with or the
// wrong key was used — never silently returns garbage as if it were the real plaintext.
export function openEnvelope(privateKey: crypto.KeyObject, envelope: SealedEnvelope): string {
  const wrappedDataKey = Buffer.from(envelope.wrappedDataKey, 'base64');
  const dataKey = crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: OAEP_HASH },
    wrappedDataKey
  );

  const iv = Buffer.from(envelope.iv, 'base64');
  const blob = Buffer.from(envelope.ciphertext, 'base64');
  const tag = blob.subarray(blob.length - 16);
  const encrypted = blob.subarray(0, blob.length - 16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
