-- A correction now states the shape of the day and lets the balance decide
-- whether it was paid. The paid/unpaid spellings stay in the type: rows written
-- before this hold them, Postgres cannot drop an enum value the data uses, and
-- each is read as the shape it described.
ALTER TYPE "AttendanceOverrideCode" ADD VALUE IF NOT EXISTS 'HALF_LEAVE';
ALTER TYPE "AttendanceOverrideCode" ADD VALUE IF NOT EXISTS 'FULL_LEAVE';
