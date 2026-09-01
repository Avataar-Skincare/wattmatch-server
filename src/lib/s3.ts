import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import fs from 'node:fs/promises';
import path from 'node:path';
import { logger } from './logger.js';

// Mirrors lib/secrets.ts's philosophy exactly: local dev needs zero AWS setup. AWS_S3_BUCKET unset
// means every call below transparently reads/writes a local directory instead; setting it (always
// true in production) switches every call to real S3 with no other code change — see
// TENDER_WORKFLOW_STAKEHOLDER_PLAN.md's Tech Stack section ("File storage — AWS S3, net-new...
// private bucket, server-side encrypted, accessed only via short-lived signed URLs").
const LOCAL_STORAGE_DIR = process.env.LOCAL_STORAGE_DIR || './local-storage';

let client: S3Client | null = null;
function getClient(): S3Client {
  if (!client) client = new S3Client({});
  return client;
}

function bucketName(): string | undefined {
  return process.env.AWS_S3_BUCKET;
}

// Every local-storage key this app generates itself is a fixed, safe shape (e.g.
// `tenders/${id}/...`) — but devLocalStorage.ts's GET route passes a caller-supplied wildcard path
// segment straight through to readObject as `key`, with no `..`-traversal check anywhere before
// this point. That route is only ever reachable while AWS_S3_BUCKET is unset (local dev/test) — but
// relying solely on that gate means a real deployment that simply forgets to set the bucket
// silently turns this into an unauthenticated path-traversal file read. Resolving and checking the
// prefix here protects every caller of every function below, not just that one route.
function resolveLocalStoragePath(key: string): string | null {
  const root = path.resolve(LOCAL_STORAGE_DIR);
  const resolved = path.resolve(root, key);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

export async function uploadObject(key: string, body: Buffer, contentType: string): Promise<void> {
  const bucket = bucketName();
  if (!bucket) {
    const filePath = resolveLocalStoragePath(key);
    if (!filePath) throw new Error(`Refusing to write outside local storage root: ${key}`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, body);
    logger.info({ key, filePath }, '[S3] AWS_S3_BUCKET not set — wrote to local storage fallback');
    return;
  }
  await getClient().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: contentType,
      // SSE-KMS per the plan's storage spec — relies on the bucket's default KMS key unless a
      // specific one is configured via AWS_S3_KMS_KEY_ID.
      ServerSideEncryption: 'aws:kms',
      ...(process.env.AWS_S3_KMS_KEY_ID ? { SSEKMSKeyId: process.env.AWS_S3_KMS_KEY_ID } : {}),
    })
  );
}

// Best-effort cleanup for the "uploaded successfully, then the DB write that was supposed to
// reference it failed" case (see tenderDocuments.ts's own comment on why upload must happen before
// the DB row can be written) — an orphaned object left behind is harmless but wasteful; failing to
// delete it is not worth failing the request over a second time, so callers should log and move on
// rather than let this throw replace the original error.
export async function deleteObject(key: string): Promise<void> {
  const bucket = bucketName();
  if (!bucket) {
    const filePath = resolveLocalStoragePath(key);
    if (!filePath) return;
    await fs.unlink(filePath).catch(() => {});
    return;
  }
  await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function readObject(key: string): Promise<Buffer | null> {
  const bucket = bucketName();
  if (!bucket) {
    const filePath = resolveLocalStoragePath(key);
    if (!filePath) return null;
    try {
      return await fs.readFile(filePath);
    } catch {
      return null;
    }
  }
  try {
    const result = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const bytes = await result.Body?.transformToByteArray();
    return bytes ? Buffer.from(bytes) : null;
  } catch {
    return null;
  }
}

// Local-storage fallback has no real signing/expiry — it's a dev-only stand-in served by
// routes/devLocalStorage.ts, which itself refuses to serve anything once AWS_S3_BUCKET is set, so
// this path is never reachable in production.
export async function getSignedDownloadUrl(
  key: string,
  expiresInSeconds = 300,
  downloadFilename?: string
): Promise<string> {
  const bucket = bucketName();
  if (!bucket) {
    const base = process.env.PUBLIC_API_URL || 'http://localhost:4000';
    const qs = downloadFilename ? `?filename=${encodeURIComponent(downloadFilename)}` : '';
    return `${base}/api/dev/local-storage/${key}${qs}`;
  }
  return getSignedUrl(
    getClient(),
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      // Forces an actual download (vs. the browser opening the PDF inline) when the caller wants
      // one — e.g. the tender/RfS documents, as opposed to invoice/template previews that are fine
      // opened in a new tab.
      ...(downloadFilename ? { ResponseContentDisposition: `attachment; filename="${downloadFilename}"` } : {}),
    }),
    { expiresIn: expiresInSeconds }
  );
}

export function isLocalStorageFallbackActive(): boolean {
  return !bucketName();
}
