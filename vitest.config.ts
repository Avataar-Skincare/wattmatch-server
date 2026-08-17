import { defineConfig } from 'vitest/config';

// Integration tests here hit real MySQL/Redis (the same local dev instances used by `npm run
// dev`), not mocks — consistent with this project's practice all along of verifying against real
// infrastructure rather than trusting a mock's approximation of it. `setupFiles` loads .env so
// DB_HOST/REDIS_HOST/etc. are available the same way they are for the app itself.
export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 15000,
  },
});
