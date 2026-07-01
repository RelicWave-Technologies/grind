CREATE TYPE "AgentRuntimeState" AS ENUM ('IDLE', 'RUNNING', 'PAUSED_IDLE', 'OFFLINE');

ALTER TABLE "User"
  ADD COLUMN "agentLastSeenAt" TIMESTAMP(3),
  ADD COLUMN "agentState" "AgentRuntimeState" NOT NULL DEFAULT 'OFFLINE',
  ADD COLUMN "agentVersion" TEXT,
  ADD COLUMN "agentPlatform" TEXT,
  ADD COLUMN "agentActiveEntryId" TEXT;

CREATE INDEX "User_workspaceId_agentState_agentLastSeenAt_idx" ON "User"("workspaceId", "agentState", "agentLastSeenAt");
