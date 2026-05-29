import { beforeEach } from 'vitest';

// CRITICAL: point every DB consumer at the test DB BEFORE @grind/db is imported,
// so the Prisma singleton is constructed against grind_test, never grind_dev.
if (!process.env.TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL not set');
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.DIRECT_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';

const { prisma } = await import('@grind/db');

beforeEach(async () => {
  // Wipe all tables between tests for deterministic isolation.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "ActivitySample","TimeSegment","TimeEntry","RefreshToken","LarkOAuthToken","LarkIdentity","Task","Project","User","Workspace" RESTART IDENTITY CASCADE',
  );
});
