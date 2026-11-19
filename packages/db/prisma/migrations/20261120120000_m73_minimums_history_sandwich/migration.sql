-- Minimum hours become dated: a change appends the old pair to the history so
-- days already judged keep the minimums they were judged on.
ALTER TABLE "LeavePolicy" ADD COLUMN "minimumsHistory" JSONB NOT NULL DEFAULT '[]';
-- The sandwich rule: off (NULL) until an admin sets the first date it judges.
ALTER TABLE "LeavePolicy" ADD COLUMN "sandwichRuleFrom" TEXT;
