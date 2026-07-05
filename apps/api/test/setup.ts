import { beforeEach } from 'vitest';

// CRITICAL: point every DB consumer at the test DB BEFORE @grind/db is imported,
// so the Prisma singleton is constructed against grind_test, never grind_dev.
if (!process.env.TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL not set');
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.DIRECT_URL = process.env.TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';

// Enable the dev-only email/password login shim for the suite — most tests
// authenticate via /v1/auth/login + seeded passwords. Lark login is covered
// separately (authLark.test.ts / larkLogin.test.ts).
process.env.ALLOW_PASSWORD_LOGIN = 'true';

// Keep the Lark integration deterministically DISABLED for the test suite,
// regardless of whether the developer's local .env has real creds. This must
// run before src/env.ts is parsed (setupFiles load before test modules). The
// configured OAuth path is exercised by live verification, not unit tests.
delete process.env.LARK_APP_ID;
delete process.env.LARK_APP_SECRET;
delete process.env.LARK_TOKEN_KEY;

// Keep Tester Ops tests deterministic regardless of the developer's local
// private-DM smoke config.
process.env.TIMO_TESTER_BOT_ENABLED = 'true';
process.env.TIMO_TESTER_GROUP_CHAT_ID = 'oc_configured_status';
process.env.TIMO_TESTER_GROUP_TIMEZONE = 'UTC';
process.env.TIMO_TESTER_PING_TIMES = '11:00,17:00';
process.env.TIMO_PASSIVE_ISSUE_DETECTION_ENABLED = 'true';

const { prisma } = await import('@grind/db');

beforeEach(async () => {
  // Wipe all tables between tests for deterministic isolation.
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "TesterOpsIssue","TesterOpsAiRun","TesterOpsEvent","TesterOpsMember","TesterOpsReminder","TesterOpsOutboxEvent","TesterOpsKnowledgeChunk","TesterOpsKnowledgeSource","TesterOpsAiPolicy","TesterOpsConfig","ManualTimeLarkOutboxEvent","ManualTimeLarkMessage","ManualTimeRequest","MtrAttendee","ActivitySample","Screenshot","TimeSegment","TimeEntryAttendee","TimeEntry","RefreshToken","AgentAuthCode","LarkOAuthToken","LarkIdentity","TeamManager","User","Team","Shift","Workspace" RESTART IDENTITY CASCADE',
  );
});
