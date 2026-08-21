-- M46: per-person accrual rate, and the last-Saturday-off rule.
--
-- The workspace holds two companies that accrue paid leave at different rates,
-- and teams do not divide along company lines, so the rate belongs on the
-- person. NULL keeps inheriting the workspace policy.
ALTER TABLE "User" ADD COLUMN "leaveAccrualDaysOverride" DOUBLE PRECISION;

-- A weekly shift pattern cannot express "the last Saturday of the month", so
-- the rule is a workspace policy the Working Calendar applies.
ALTER TABLE "LeavePolicy" ADD COLUMN "lastSaturdayOff" BOOLEAN NOT NULL DEFAULT false;
