-- One grace period for everyone: the late arrival rule no longer reads each
-- shift's bufferMin, several of which are 0.
ALTER TABLE "LeavePolicy" ADD COLUMN "lateGraceMinutes" INTEGER NOT NULL DEFAULT 30;
