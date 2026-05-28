import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['./test/setup.ts'],
    // Serialize: all tests share one Postgres test DB; no parallel clobbering.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
  },
});
