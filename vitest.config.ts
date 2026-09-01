import { defineConfig } from 'vitest/config';

// Integration tests here hit real MySQL/Redis (the same local dev instances used by `npm run
// dev`), not mocks — consistent with this project's practice all along of verifying against real
// infrastructure rather than trusting a mock's approximation of it. `setupFiles` loads .env so
// DB_HOST/REDIS_HOST/etc. are available the same way they are for the app itself.
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 15000,
    // Rate limiting (lib/rateLimit.ts) is Redis-backed by design — correct across multiple server
    // instances in production, but it means the SAME Redis instance is shared across every test
    // FILE in a run, not just every test. vitest.setup.ts's beforeEach flushes rate-limit keys so
    // each test starts clean, but with files running in parallel (the default), one file's flush
    // can land mid-loop inside another file's own rate-limit test and wipe its progress — a real,
    // observed flake, not a hypothetical one. Running files sequentially removes that race entirely.
    fileParallelism: false,
  },
});
