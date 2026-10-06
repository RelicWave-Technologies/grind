-- Late on a first-half leave day: punch-in after a fixed clock time (14:00 by
-- default), no grace. Before this, half-day leave days were never late.
ALTER TABLE "LeavePolicy" ADD COLUMN "halfDayLateAfterMinute" INTEGER NOT NULL DEFAULT 840;
