import { execSync } from 'node:child_process';

/**
 * Migrate the benchmark's own database. It is TRUNCATEd and reseeded by the
 * benchmark, so it must never be a database anything else relies on: set
 * PERF_DATABASE_URL to a dedicated local database (falls back to the test DB).
 */
export default function globalSetup() {
  const url = process.env.PERF_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('PERF_DATABASE_URL / TEST_DATABASE_URL is not set');
  if (!/localhost|127\.0\.0\.1/.test(url)) throw new Error('refusing to run the benchmark against a non-local database');
  execSync('pnpm --filter @grind/db exec prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });
}
