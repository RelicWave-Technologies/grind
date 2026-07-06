-- Add a read-only general answer action for Timo persona/help replies.
ALTER TYPE "TesterOpsSafeAction" ADD VALUE IF NOT EXISTS 'ANSWER_GENERAL';

ALTER TABLE "TesterOpsAiPolicy"
  ALTER COLUMN "allowedActions" SET DEFAULT ARRAY[
    'NONE',
    'LOG_ISSUE',
    'ASK_CLARIFICATION',
    'ANSWER_FROM_DOCS',
    'ANSWER_GENERAL',
    'GET_USAGE_STATUS',
    'SEND_PING'
  ]::TEXT[];

UPDATE "TesterOpsAiPolicy"
SET "allowedActions" = array_append(COALESCE("allowedActions", ARRAY[]::TEXT[]), 'ANSWER_GENERAL')
WHERE NOT ('ANSWER_GENERAL' = ANY(COALESCE("allowedActions", ARRAY[]::TEXT[])));
