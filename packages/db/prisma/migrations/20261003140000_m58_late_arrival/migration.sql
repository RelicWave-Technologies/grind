-- Late arrival rule: this many late arrivals a month are free; each one after
-- is half a day of leave. Grace comes from each shift's existing bufferMin.
ALTER TABLE "LeavePolicy" ADD COLUMN "lateAllowedPerMonth" INTEGER NOT NULL DEFAULT 4;
