-- m65: Timo sync health. Server-clock bookkeeping for the per-person sync
-- verdict, and the once-per-episode stuck-sync alert. Additive and nullable.
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "agentSyncPendingSince" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "agentSyncErrorSince" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "agentSyncAlertedAt" TIMESTAMP(3);
