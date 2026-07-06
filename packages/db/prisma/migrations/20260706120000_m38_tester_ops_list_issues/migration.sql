-- Add a read-only action so Timo can list/summarize logged tester issues on request.
ALTER TYPE "TesterOpsSafeAction" ADD VALUE IF NOT EXISTS 'LIST_ISSUES';

ALTER TABLE "TesterOpsAiPolicy"
  ALTER COLUMN "allowedActions" SET DEFAULT ARRAY[
    'NONE',
    'LOG_ISSUE',
    'ASK_CLARIFICATION',
    'ANSWER_FROM_DOCS',
    'ANSWER_GENERAL',
    'GET_USAGE_STATUS',
    'SEND_PING',
    'LIST_ISSUES'
  ]::TEXT[];

UPDATE "TesterOpsAiPolicy"
SET "allowedActions" = array_append(COALESCE("allowedActions", ARRAY[]::TEXT[]), 'LIST_ISSUES')
WHERE NOT ('LIST_ISSUES' = ANY(COALESCE("allowedActions", ARRAY[]::TEXT[])));
