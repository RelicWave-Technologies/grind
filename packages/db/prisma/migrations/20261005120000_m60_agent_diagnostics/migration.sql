-- Device and local sync-queue health reported by the desktop agent heartbeat.
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "agentOsVersion" TEXT,
  ADD COLUMN IF NOT EXISTS "agentArch" TEXT,
  ADD COLUMN IF NOT EXISTS "agentSyncPending" INTEGER,
  ADD COLUMN IF NOT EXISTS "agentSyncOldestPendingAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "agentSyncLastError" TEXT,
  ADD COLUMN IF NOT EXISTS "agentDiagnosticsUpdatedAt" TIMESTAMP(3);
