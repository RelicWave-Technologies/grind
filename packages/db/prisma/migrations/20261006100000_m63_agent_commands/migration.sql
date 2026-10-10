-- Developer-triggered commands for a person's desktop agent (v1: RESYNC).
-- Additive: a new table and two enums; nothing existing changes.
CREATE TYPE "AgentCommandType" AS ENUM ('RESYNC');
CREATE TYPE "AgentCommandStatus" AS ENUM ('PENDING', 'DELIVERED', 'DONE', 'FAILED', 'EXPIRED');

CREATE TABLE "AgentCommand" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "type" "AgentCommandType" NOT NULL,
    "params" JSONB NOT NULL,
    "status" "AgentCommandStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "result" JSONB,
    "error" TEXT,
    CONSTRAINT "AgentCommand_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentCommand_userId_status_idx" ON "AgentCommand"("userId", "status");
CREATE INDEX "AgentCommand_workspaceId_createdAt_idx" ON "AgentCommand"("workspaceId", "createdAt");

ALTER TABLE "AgentCommand" ADD CONSTRAINT "AgentCommand_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentCommand" ADD CONSTRAINT "AgentCommand_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentCommand" ADD CONSTRAINT "AgentCommand_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
