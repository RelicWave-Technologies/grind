-- CreateEnum
CREATE TYPE "TesterOpsAiProvider" AS ENUM ('OPENROUTER', 'DEEPSEEK');

-- CreateEnum
CREATE TYPE "TesterOpsEventSource" AS ENUM ('LARK_EVENT', 'HISTORY_POLL', 'MANUAL_REPLAY');

-- CreateEnum
CREATE TYPE "TesterOpsEventStatus" AS ENUM ('PENDING', 'PROCESSED', 'IGNORED', 'FAILED');

-- CreateEnum
CREATE TYPE "TesterOpsIntent" AS ENUM ('ISSUE_REPORT', 'DOC_QUESTION', 'USAGE_STATUS', 'PING_REQUEST', 'GENERAL_HELP', 'IRRELEVANT');

-- CreateEnum
CREATE TYPE "TesterOpsSafeAction" AS ENUM ('NONE', 'LOG_ISSUE', 'ASK_CLARIFICATION', 'ANSWER_FROM_DOCS', 'GET_USAGE_STATUS', 'SEND_PING');

-- CreateEnum
CREATE TYPE "TesterOpsIssueStatus" AS ENUM ('CANDIDATE', 'OPEN', 'RESOLVED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "TesterOpsIssueSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "TesterOpsOutboxKind" AS ENUM ('SEND_TEXT', 'SEND_CARD');

-- CreateEnum
CREATE TYPE "TesterOpsOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED', 'DEAD_LETTER');

-- CreateTable
CREATE TABLE "TesterOpsConfig" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "chatId" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "pingTimes" TEXT[] DEFAULT ARRAY['11:00', '17:00']::TEXT[],
    "passiveIssueDetectionEnabled" BOOLEAN NOT NULL DEFAULT false,
    "announcementSentAt" TIMESTAMP(3),
    "pollCursor" TEXT,
    "lastHistoryPollAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TesterOpsConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TesterOpsAiPolicy" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" "TesterOpsAiProvider" NOT NULL DEFAULT 'OPENROUTER',
    "model" TEXT,
    "promptVersion" TEXT NOT NULL DEFAULT 'tester-ops-v1',
    "temperature" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "highConfidenceThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.78,
    "mediumConfidenceThreshold" DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    "maxClarifyingQuestions" INTEGER NOT NULL DEFAULT 1,
    "allowedActions" TEXT[] DEFAULT ARRAY['NONE', 'LOG_ISSUE', 'ASK_CLARIFICATION', 'ANSWER_FROM_DOCS', 'GET_USAGE_STATUS', 'SEND_PING']::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TesterOpsAiPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TesterOpsMember" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "openId" TEXT NOT NULL,
    "userId" TEXT,
    "displayName" TEXT,
    "isTester" BOOLEAN NOT NULL DEFAULT true,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TesterOpsMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TesterOpsEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "source" "TesterOpsEventSource" NOT NULL,
    "sourceId" TEXT NOT NULL,
    "chatId" TEXT,
    "messageId" TEXT,
    "senderOpenId" TEXT,
    "memberId" TEXT,
    "messageText" TEXT NOT NULL,
    "raw" JSONB,
    "status" "TesterOpsEventStatus" NOT NULL DEFAULT 'PENDING',
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TesterOpsEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TesterOpsIssue" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "eventId" TEXT,
    "reporterMemberId" TEXT,
    "reporterUserId" TEXT,
    "reporterOpenId" TEXT,
    "status" "TesterOpsIssueStatus" NOT NULL DEFAULT 'CANDIDATE',
    "intent" "TesterOpsIntent" NOT NULL DEFAULT 'ISSUE_REPORT',
    "category" TEXT,
    "severity" "TesterOpsIssueSeverity" NOT NULL DEFAULT 'LOW',
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "summary" TEXT NOT NULL,
    "sourceMessageText" TEXT,
    "sourceMessageId" TEXT,
    "clarifyingQuestion" TEXT,
    "replyText" TEXT,
    "citations" JSONB,
    "aiRunId" TEXT,
    "adminNote" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TesterOpsIssue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TesterOpsReminder" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "messageId" TEXT,
    "usageSnapshot" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TesterOpsReminder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TesterOpsOutboxEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" "TesterOpsOutboxKind" NOT NULL,
    "status" "TesterOpsOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "chatId" TEXT,
    "openId" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastError" TEXT,
    "messageId" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TesterOpsOutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TesterOpsKnowledgeSource" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "url" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastFetchedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "contentHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TesterOpsKnowledgeSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TesterOpsKnowledgeChunk" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "embedding" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TesterOpsKnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TesterOpsAiRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "eventId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "safeAction" "TesterOpsSafeAction",
    "confidence" DOUBLE PRECISION,
    "latencyMs" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TesterOpsAiRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TesterOpsConfig_workspaceId_key" ON "TesterOpsConfig"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "TesterOpsAiPolicy_workspaceId_key" ON "TesterOpsAiPolicy"("workspaceId");

-- CreateIndex
CREATE INDEX "TesterOpsMember_workspaceId_idx" ON "TesterOpsMember"("workspaceId");

-- CreateIndex
CREATE INDEX "TesterOpsMember_userId_idx" ON "TesterOpsMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "TesterOpsMember_workspaceId_openId_key" ON "TesterOpsMember"("workspaceId", "openId");

-- CreateIndex
CREATE INDEX "TesterOpsEvent_workspaceId_status_receivedAt_idx" ON "TesterOpsEvent"("workspaceId", "status", "receivedAt");

-- CreateIndex
CREATE INDEX "TesterOpsEvent_messageId_idx" ON "TesterOpsEvent"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "TesterOpsEvent_workspaceId_source_sourceId_key" ON "TesterOpsEvent"("workspaceId", "source", "sourceId");

-- CreateIndex
CREATE INDEX "TesterOpsIssue_workspaceId_status_createdAt_idx" ON "TesterOpsIssue"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "TesterOpsIssue_eventId_idx" ON "TesterOpsIssue"("eventId");

-- CreateIndex
CREATE INDEX "TesterOpsIssue_reporterUserId_idx" ON "TesterOpsIssue"("reporterUserId");

-- CreateIndex
CREATE INDEX "TesterOpsReminder_workspaceId_sentAt_idx" ON "TesterOpsReminder"("workspaceId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "TesterOpsReminder_workspaceId_scheduledFor_key" ON "TesterOpsReminder"("workspaceId", "scheduledFor");

-- CreateIndex
CREATE UNIQUE INDEX "TesterOpsOutboxEvent_idempotencyKey_key" ON "TesterOpsOutboxEvent"("idempotencyKey");

-- CreateIndex
CREATE INDEX "TesterOpsOutboxEvent_workspaceId_status_nextRunAt_idx" ON "TesterOpsOutboxEvent"("workspaceId", "status", "nextRunAt");

-- CreateIndex
CREATE INDEX "TesterOpsKnowledgeSource_workspaceId_enabled_idx" ON "TesterOpsKnowledgeSource"("workspaceId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "TesterOpsKnowledgeSource_workspaceId_token_key" ON "TesterOpsKnowledgeSource"("workspaceId", "token");

-- CreateIndex
CREATE INDEX "TesterOpsKnowledgeChunk_sourceId_idx" ON "TesterOpsKnowledgeChunk"("sourceId");

-- CreateIndex
CREATE INDEX "TesterOpsKnowledgeChunk_contentHash_idx" ON "TesterOpsKnowledgeChunk"("contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "TesterOpsKnowledgeChunk_sourceId_ordinal_key" ON "TesterOpsKnowledgeChunk"("sourceId", "ordinal");

-- CreateIndex
CREATE INDEX "TesterOpsAiRun_workspaceId_createdAt_idx" ON "TesterOpsAiRun"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "TesterOpsAiRun_eventId_idx" ON "TesterOpsAiRun"("eventId");

-- AddForeignKey
ALTER TABLE "TesterOpsConfig" ADD CONSTRAINT "TesterOpsConfig_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TesterOpsAiPolicy" ADD CONSTRAINT "TesterOpsAiPolicy_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TesterOpsMember" ADD CONSTRAINT "TesterOpsMember_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TesterOpsMember" ADD CONSTRAINT "TesterOpsMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TesterOpsEvent" ADD CONSTRAINT "TesterOpsEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TesterOpsEvent" ADD CONSTRAINT "TesterOpsEvent_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "TesterOpsMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TesterOpsIssue" ADD CONSTRAINT "TesterOpsIssue_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TesterOpsIssue" ADD CONSTRAINT "TesterOpsIssue_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "TesterOpsEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TesterOpsIssue" ADD CONSTRAINT "TesterOpsIssue_reporterMemberId_fkey" FOREIGN KEY ("reporterMemberId") REFERENCES "TesterOpsMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TesterOpsIssue" ADD CONSTRAINT "TesterOpsIssue_reporterUserId_fkey" FOREIGN KEY ("reporterUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TesterOpsIssue" ADD CONSTRAINT "TesterOpsIssue_aiRunId_fkey" FOREIGN KEY ("aiRunId") REFERENCES "TesterOpsAiRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TesterOpsReminder" ADD CONSTRAINT "TesterOpsReminder_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TesterOpsOutboxEvent" ADD CONSTRAINT "TesterOpsOutboxEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TesterOpsKnowledgeSource" ADD CONSTRAINT "TesterOpsKnowledgeSource_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TesterOpsKnowledgeChunk" ADD CONSTRAINT "TesterOpsKnowledgeChunk_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "TesterOpsKnowledgeSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TesterOpsAiRun" ADD CONSTRAINT "TesterOpsAiRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TesterOpsAiRun" ADD CONSTRAINT "TesterOpsAiRun_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "TesterOpsEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
