-- M47: the last-Saturday rule varies by employer, not by workspace.
--
-- Only one of the two companies sharing this workspace takes the last Saturday
-- off. Teams do not divide along company lines, so — as with the accrual rate —
-- the flag sits on the person. NULL keeps inheriting the workspace policy.
ALTER TABLE "User" ADD COLUMN "lastSaturdayOffOverride" BOOLEAN;
