import { execSync } from 'node:child_process';

/**
 * Runs once before the whole suite: apply migrations to the dedicated test DB
 * (TEST_DATABASE_URL → grind_test). Never touches the dev DB.
 */
export default function globalSetup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('TEST_DATABASE_URL is not set — refusing to run API tests against the dev DB');
  }
  execSync('pnpm --filter @grind/db exec prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
  });
}
