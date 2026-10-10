-- m66: evidence can name a time entry the server does not have yet.
-- An installed agent whose entry create is stuck in its sync queue still
-- uploads the screenshots and activity minutes taken under it. They are stored
-- detached and remember the entry id they claimed; when that entry arrives for
-- the same person, they are linked to it. Additive and nullable — no existing
-- row changes.
ALTER TABLE "Screenshot" ADD COLUMN IF NOT EXISTS "claimedTimeEntryId" TEXT;
CREATE INDEX IF NOT EXISTS "Screenshot_claimedTimeEntryId_idx" ON "Screenshot"("claimedTimeEntryId");

-- No index: ActivitySample is the largest table, and the link looks a claim up
-- inside the (userId, bucketStart) unique index from the entry's start.
ALTER TABLE "ActivitySample" ADD COLUMN IF NOT EXISTS "claimedTimeEntryId" TEXT;
