import 'dotenv/config';
import { beforeEach } from 'vitest';
import { redis } from './src/lib/redis.js';

// lib/rateLimit.ts's limiters are Redis-backed by design (correct across multiple server instances
// in production — see that file's own comment) — but it means hits now accumulate in the SAME
// Redis instance across every test file in one `npm test` run, unlike the old in-memory
// per-process counters this replaced (which effectively reset per test file under vitest's module
// isolation). A test file exercising a tightly-limited route (e.g. a 10/15min admin action
// limiter) could then fail from OTHER, unrelated test files' cumulative hits, not its own. Flushing
// before every test keeps each one starting from a clean slate, matching what the old in-memory
// limiters gave for free — this file only ever runs inside the test harness, never in production.
beforeEach(async () => {
  const keys = await redis.keys('ratelimit:*');
  if (keys.length > 0) await redis.del(...keys);
});
