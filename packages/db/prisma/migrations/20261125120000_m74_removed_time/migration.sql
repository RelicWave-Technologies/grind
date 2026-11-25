-- An invalidation no longer needs a flag: a person can remove part of their own
-- tracked time on Edit Time. Those rows have no flag; the window, the reason and
-- who did it are the same columns a flag review fills.
ALTER TABLE "TimeInvalidation" ALTER COLUMN "flagId" DROP NOT NULL;
