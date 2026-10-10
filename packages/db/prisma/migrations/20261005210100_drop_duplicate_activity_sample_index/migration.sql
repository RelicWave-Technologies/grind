-- "ActivitySample_userId_bucketStart_key" (the unique constraint) already
-- indexes ("userId", "bucketStart"); this plain index duplicated it and only
-- added write cost to every sample insert. Dropping an index removes no data.
DROP INDEX IF EXISTS "ActivitySample_userId_bucketStart_idx";
