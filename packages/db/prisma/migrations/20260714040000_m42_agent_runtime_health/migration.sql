-- Additive only. Older agents may omit both the new state and startup snapshot.
ALTER TYPE "AgentRuntimeState" ADD VALUE IF NOT EXISTS 'PAUSED_PERMISSION';

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "agentLaunchAtLoginState" TEXT,
  ADD COLUMN IF NOT EXISTS "agentLaunchOrigin" TEXT,
  ADD COLUMN IF NOT EXISTS "agentLaunchAtLoginUpdatedAt" TIMESTAMP(3);
