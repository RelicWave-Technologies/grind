import { defineConfig } from 'vitest/config';

/**
 * Opt-in endpoint benchmark (`pnpm test:perf`). Not part of `vitest run`: it
 * seeds ~1.5M rows into its own database (PERF_DATABASE_URL) and keeps them
 * between runs, so it
 * has its own setup (no per-test TRUNCATE) and its own file suffix.
 */
export default defineConfig({
  test: {
    globalSetup: ['./test/perf/globalSetup.ts'],
    setupFiles: ['./test/perf/setup.ts'],
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    hookTimeout: 900_000,
    testTimeout: 900_000,
    include: ['test/perf/**/*.perf.ts'],
  },
});
