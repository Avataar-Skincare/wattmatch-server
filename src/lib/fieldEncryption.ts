import crypto from 'node:crypto';
import { KMSClient, EncryptCommand, DecryptCommand } from '@aws-sdk/client-kms';
import { logger } from './logger.js';

// Application-level field encryption for PII the live auction module stores at rest — currently
// just AuctionParticipant.organizationName (see LIVE_AUCTION_IDENTITY_ENCRYPTION_PLAN.md for why:
// the live UI only ever shows an alias, but the DB row held the real name in plaintext). This is
// NOT the vetting-bid custodian scheme (VETTING_BID_SEALING_IMPLEMENTATION_PLAN.md) — this is
// ordinary PII-at-rest protection, where legitimate roles (buyer, admin) can decrypt when
// authorized, not a "not even admin" guarantee.
//
// Every ciphertext is tagged with a scheme prefix (`kms:`/`local:`) so a value produced one way
// can never be silently mis-decrypted the other way — a mismatch fails loudly instead of either
// throwing an opaque low-level crypto error or, worse, appearing to "succeed" with garbage.
const KMS_SCHEME = 'kms';
const LOCAL_SCHEME = 'local';

let kmsClient: KMSClient | null = null;
function getKmsClient(): KMSClient {
  if (!kmsClient) kmsClient = new KMSClient({});
  return kmsClient;
}

// Same fallback shape as auctionTokens.ts's JWT secret: a fixed, clearly-labelled insecure default
// so local dev needs zero AWS/config setup, while warning loudly on every use that it's active.
// Unlike a randomly-generated fallback, this is deterministic across restarts — otherwise every
// dev-server restart would make previously-encrypted local rows permanently undecryptable.
const DEV_ONLY_INSECURE_KEY = crypto.createHash('sha256').update('dev-only-insecure-field-encryption-key').digest();

function getLocalKey(): Buffer {
  const configured = process.env.FIELD_ENCRYPTION_KEY;
  if (configured) return crypto.createHash('sha256').update(configured).digest();
  logger.warn('FIELD_ENCRYPTION_KEY is not set — falling back to an insecure dev-only default. Set it before any real test.');
  return DEV_ONLY_INSECURE_KEY;
}

function usesKms(): boolean {
  return Boolean(process.env.FIELD_ENCRYPTION_KMS_KEY_ID);
}

// AES-256-GCM, IV + auth tag + ciphertext concatenated into one buffer (same wire-format choice as
// vettingCrypto's browser-interop concatenation, kept consistent within this codebase) — the GCM
// tag is what turns a tampered/corrupted ciphertext into a clean decrypt failure rather than
// silently returning garbage bytes as if they were the real plaintext.
function localEncrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getLocalKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([iv, tag, encrypted]);
  return `${LOCAL_SCHEME}:${blob.toString('base64')}`;
}

function localDecrypt(body: string): string {
  const blob = Buffer.from(body, 'base64');
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const encrypted = blob.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getLocalKey(), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch (err) {
    // Node's raw error here ("Unsupported state or unable to authenticate data") gives no hint
    // about the actual cause. The overwhelmingly likely one: FIELD_ENCRYPTION_KEY was changed (or
    // unset/reset to the dev-only default) after this value was encrypted under a different key —
    // unlike KMS (which embeds the key ID in its ciphertext and keeps old key material available
    // through rotation), this local fallback has no key-versioning, so a changed key makes every
    // previously-encrypted row permanently undecryptable with no automatic recovery. Re-thrown with
    // that context so it's diagnosable instead of a dead end nobody can explain, not to imply this
    // module can recover the value itself — it can't; the fix is operational (restore the original
    // key) or, if it's truly gone, the field is unrecoverable and needs a real re-collection.
    throw new Error(
      'Failed to decrypt field value under the current FIELD_ENCRYPTION_KEY — this almost always means the key has changed since this value was encrypted (local scheme has no key-versioning, unlike KMS). Original error: ' +
        (err instanceof Error ? err.message : String(err))
    );
  }
}

export async function encryptField(plaintext: string): Promise<string> {
  if (usesKms()) {
    const result = await getKmsClient().send(
      new EncryptCommand({ KeyId: process.env.FIELD_ENCRYPTION_KMS_KEY_ID, Plaintext: Buffer.from(plaintext, 'utf8') })
    );
    if (!result.CiphertextBlob) throw new Error('KMS Encrypt returned no CiphertextBlob');
    return `${KMS_SCHEME}:${Buffer.from(result.CiphertextBlob).toString('base64')}`;
  }
  return localEncrypt(plaintext);
}

export async function decryptField(value: string): Promise<string> {
  const separatorIndex = value.indexOf(':');
  const scheme = separatorIndex === -1 ? null : value.slice(0, separatorIndex);
  const body = separatorIndex === -1 ? '' : value.slice(separatorIndex + 1);

  if (scheme === KMS_SCHEME) {
    const result = await getKmsClient().send(new DecryptCommand({ CiphertextBlob: Buffer.from(body, 'base64') }));
    if (!result.Plaintext) throw new Error('KMS Decrypt returned no Plaintext');
    return Buffer.from(result.Plaintext).toString('utf8');
  }
  if (scheme === LOCAL_SCHEME) {
    return localDecrypt(body);
  }
  // Deliberately not a fallback to "try both" — a value with an unrecognized or missing scheme
  // prefix is either corrupted or was never encrypted through this module at all, and guessing
  // which scheme to try would risk exactly the "silently produces garbage" failure mode the scheme
  // prefix exists to prevent.
  throw new Error(`Cannot decrypt field value: unrecognized encryption scheme ${scheme === null ? '(missing)' : `"${scheme}"`}`);
}
