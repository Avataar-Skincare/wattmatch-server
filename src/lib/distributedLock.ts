import { randomUUID } from 'node:crypto';
import { redis } from './redis.js';

// A short-lived Redis mutex for serializing a check-then-act critical section across concurrent
// requests/instances — the same problem class rateLimit.ts already solves via Redis (a per-process
// lock would be silently wrong the moment there's more than one server instance). Token-guarded
// release (via a Lua script, not a plain DEL) so a lock that outlives its TTL and gets acquired by
// someone else can never be released by the original, now-late holder.
const RELEASE_IF_OWNER_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

export class LockContentionError extends Error {
  constructor(key: string) {
    super(`Could not acquire lock: ${key}`);
    this.name = 'LockContentionError';
  }
}

// Runs `fn` while holding the lock, releasing it afterwards regardless of outcome. Throws
// LockContentionError immediately (no internal retry/backoff) if the lock is already held — callers
// decide what "someone else is already doing this" should mean for their own request (e.g. a 409
// asking the client to retry), rather than this helper silently blocking for an unknown duration.
export async function withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const token = randomUUID();
  const acquired = await redis.set(key, token, 'PX', ttlMs, 'NX');
  if (acquired !== 'OK') {
    throw new LockContentionError(key);
  }
  try {
    return await fn();
  } finally {
    await redis.eval(RELEASE_IF_OWNER_SCRIPT, 1, key, token).catch(() => {});
  }
}
