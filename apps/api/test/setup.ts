import { beforeEach } from 'vitest';

// CRITICAL: point every DB consumer at the test DB BEFORE @grind/db is imported,
// so the Prisma singleton is constructed against grind_test, never grind_dev.
if (!process.env.TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL not set');
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.DIRECT_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';

// Keep the Lark integration deterministically DISABLED for the test suite,
// regardless of whether the developer's local .env has real creds. This must
// run before src/env.ts is parsed (setupFiles load before test modules). The
// configured OAuth path is exercised by live verification, not unit tests.
delete process.env.LARK_APP_ID;
delete process.env.LARK_APP_SECRET;
delete process.env.LARK_TOKEN_KEY;

const { prisma } = await import('@grind/db');

beforeEach(async () => {
  // Wipe all tables between tests for deterministic isolation.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ManualTimeRequest","ActivitySample","TimeSegment","TimeEntry","RefreshToken","LarkOAuthToken","LarkIdentity","User","Workspace" RESTART IDENTITY CASCADE',
  );
});
