-- The month leave accounting begins, as YYYY-MM.
-- NULL keeps the previous behaviour: accrue from each person's joining month.
ALTER TABLE "LeavePolicy" ADD COLUMN "ledgerStartMonth" TEXT;
