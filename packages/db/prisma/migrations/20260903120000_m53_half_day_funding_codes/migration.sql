-- A half day now says whether a balance paid for it, the same as a full day
-- does. `HD` stays in the type: rows written before the split still hold it,
-- and Postgres cannot drop an enum value that data uses. It is no longer
-- offered in the UI, and the report reads it as PL_HD.
ALTER TYPE "AttendanceOverrideCode" ADD VALUE IF NOT EXISTS 'PL_HD';
ALTER TYPE "AttendanceOverrideCode" ADD VALUE IF NOT EXISTS 'LWP_HD';
