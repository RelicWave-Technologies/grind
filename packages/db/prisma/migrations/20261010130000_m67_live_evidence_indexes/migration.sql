-- Live evidence reads the newest sample and screenshot of each open entry on
-- every overview, report and approval load. With these it is one index probe
-- per entry instead of a scan of every row the entry ever stored. Additive.
CREATE INDEX IF NOT EXISTS "ActivitySample_timeEntryId_bucketStart_idx" ON "ActivitySample"("timeEntryId", "bucketStart");
CREATE INDEX IF NOT EXISTS "Screenshot_timeEntryId_capturedAt_idx" ON "Screenshot"("timeEntryId", "capturedAt");
