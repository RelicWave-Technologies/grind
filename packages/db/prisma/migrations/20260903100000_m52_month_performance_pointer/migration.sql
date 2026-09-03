-- Month performance pointers: one stored verdict per person per month.
--
-- Everything in this table is derived from the month report, so it is safe to
-- truncate and recompute. It exists so a closed month keeps the verdict it had
-- when it closed, and so "who was red in August" is an index scan rather than a
-- rebuild of thirty-one days for a hundred people.

DO $$ BEGIN
  CREATE TYPE "PerformanceBand" AS ENUM ('RED', 'YELLOW', 'GREEN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "MonthPerformancePointer" (
  "id"                  TEXT NOT NULL,
  "workspaceId"         TEXT NOT NULL,
  "userId"              TEXT NOT NULL,
  "month"               TEXT NOT NULL,

  "workedDays"          INTEGER NOT NULL,
  "fullDays"            INTEGER NOT NULL,
  "halfDays"            INTEGER NOT NULL,
  "workMinutes"         INTEGER NOT NULL,
  "avgMinutes"          INTEGER NOT NULL,
  -- NULL when workedDays is 0: nothing to judge is not the same as critical.
  "band"                "PerformanceBand",

  "fullDaysUnderSix"    INTEGER NOT NULL,
  "halfDaysUpToTwo"     INTEGER NOT NULL,
  "fullDaysNineOrMore"  INTEGER NOT NULL,
  "halfDaysOverFive"    INTEGER NOT NULL,

  "lateDays"            INTEGER NOT NULL,
  "lateDaysAfterBuffer" INTEGER NOT NULL,
  "earlyDays"           INTEGER NOT NULL,
  "daysWithoutPunch"    INTEGER NOT NULL,

  "computedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"           TIMESTAMP(3) NOT NULL,

  CONSTRAINT "MonthPerformancePointer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "MonthPerformancePointer_userId_month_key"
  ON "MonthPerformancePointer" ("userId", "month");
CREATE INDEX IF NOT EXISTS "MonthPerformancePointer_workspaceId_month_band_idx"
  ON "MonthPerformancePointer" ("workspaceId", "month", "band");

DO $$ BEGIN
  ALTER TABLE "MonthPerformancePointer"
    ADD CONSTRAINT "MonthPerformancePointer_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "MonthPerformancePointer"
    ADD CONSTRAINT "MonthPerformancePointer_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
