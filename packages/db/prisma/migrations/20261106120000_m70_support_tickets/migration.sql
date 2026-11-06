-- M70: support tickets. Additive: new tables and enums, and WorkspacePolicy.ticketAdminIds.
-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_ON_USER', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TicketCloseReason" AS ENUM ('USER_CONFIRMED', 'AUTO_CONFIRMED', 'WITHDRAWN', 'DUPLICATE', 'NO_RESPONSE', 'ADMIN');

-- CreateEnum
CREATE TYPE "TicketCategory" AS ENUM ('TIMO_APP', 'TIME_ATTENDANCE', 'LEAVE_PAYROLL', 'ACCESS', 'OTHER');

-- CreateEnum
CREATE TYPE "TicketPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "TicketSource" AS ENUM ('DASHBOARD', 'LARK', 'ADMIN');

-- CreateEnum
CREATE TYPE "TicketVia" AS ENUM ('DASHBOARD', 'LARK', 'SYSTEM');

-- CreateEnum
CREATE TYPE "TicketEventKind" AS ENUM ('CREATED', 'COMMENT', 'INTERNAL_NOTE', 'STATUS', 'ASSIGNED', 'PRIORITY');

-- CreateEnum
CREATE TYPE "TicketLarkCardStatus" AS ENUM ('PENDING', 'SENT', 'SEND_FAILED', 'EXPIRED', 'RETIRED');

-- CreateEnum
CREATE TYPE "TicketOutboxKind" AS ENUM ('CREATED', 'COMMENT', 'ASK_USER', 'USER_REPLY', 'STATUS', 'ASSIGNED', 'RESOLVED', 'REOPENED', 'CLOSED', 'ADMIN_REMINDER', 'USER_REMINDER', 'REFRESH');

-- CreateEnum
CREATE TYPE "TicketOutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "TicketDraftStatus" AS ENUM ('OPEN', 'USED', 'CANCELLED');

-- AlterTable
ALTER TABLE "WorkspacePolicy" ADD COLUMN     "ticketAdminIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "Ticket" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "subject" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" "TicketCategory" NOT NULL DEFAULT 'OTHER',
    "priority" "TicketPriority" NOT NULL DEFAULT 'NORMAL',
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "closeReason" "TicketCloseReason",
    "source" "TicketSource" NOT NULL,
    "requesterId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "assigneeId" TEXT,
    "duplicateOfId" TEXT,
    "idempotencyKey" TEXT,
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstAdminResponseAt" TIMESTAMP(3),
    "lastAdminActivityAt" TIMESTAMP(3),
    "lastUserActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "adminReminderCount" INTEGER NOT NULL DEFAULT 0,
    "lastAdminReminderAt" TIMESTAMP(3),
    "userReminderCount" INTEGER NOT NULL DEFAULT 0,
    "lastUserReminderAt" TIMESTAMP(3),
    "requesterUnreachable" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketEvent" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "kind" "TicketEventKind" NOT NULL,
    "actorId" TEXT,
    "body" TEXT,
    "fromStatus" "TicketStatus",
    "toStatus" "TicketStatus",
    "via" "TicketVia" NOT NULL,
    "meta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketAttachment" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT,
    "eventId" TEXT,
    "draftId" TEXT,
    "uploaderId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketLarkCard" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "recipientUserId" TEXT NOT NULL,
    "recipientOpenId" TEXT NOT NULL,
    "messageId" TEXT,
    "status" "TicketLarkCardStatus" NOT NULL DEFAULT 'PENDING',
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketLarkCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketLarkMessage" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "recipientOpenId" TEXT NOT NULL,
    "toAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketLarkMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketOutboxEvent" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "kind" "TicketOutboxKind" NOT NULL,
    "eventId" TEXT,
    "status" "TicketOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastError" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketOutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketDraft" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT '',
    "status" "TicketDraftStatus" NOT NULL DEFAULT 'OPEN',
    "offerMessageId" TEXT,
    "ticketId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketDigest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketDigest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Ticket_workspaceId_status_idx" ON "Ticket"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Ticket_requesterId_createdAt_idx" ON "Ticket"("requesterId", "createdAt");

-- CreateIndex
CREATE INDEX "Ticket_assigneeId_status_idx" ON "Ticket"("assigneeId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_workspaceId_number_key" ON "Ticket"("workspaceId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Ticket_createdById_idempotencyKey_key" ON "Ticket"("createdById", "idempotencyKey");

-- CreateIndex
CREATE INDEX "TicketEvent_ticketId_createdAt_idx" ON "TicketEvent"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "TicketAttachment_ticketId_idx" ON "TicketAttachment"("ticketId");

-- CreateIndex
CREATE INDEX "TicketAttachment_uploaderId_createdAt_idx" ON "TicketAttachment"("uploaderId", "createdAt");

-- CreateIndex
CREATE INDEX "TicketAttachment_draftId_idx" ON "TicketAttachment"("draftId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketLarkCard_ticketId_recipientOpenId_key" ON "TicketLarkCard"("ticketId", "recipientOpenId");

-- CreateIndex
CREATE UNIQUE INDEX "TicketLarkMessage_messageId_key" ON "TicketLarkMessage"("messageId");

-- CreateIndex
CREATE INDEX "TicketLarkMessage_ticketId_idx" ON "TicketLarkMessage"("ticketId");

-- CreateIndex
CREATE INDEX "TicketOutboxEvent_status_nextRunAt_idx" ON "TicketOutboxEvent"("status", "nextRunAt");

-- CreateIndex
CREATE INDEX "TicketOutboxEvent_ticketId_idx" ON "TicketOutboxEvent"("ticketId");

-- CreateIndex
CREATE INDEX "TicketDraft_userId_status_idx" ON "TicketDraft"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TicketDigest_workspaceId_day_key" ON "TicketDigest"("workspaceId", "day");

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketEvent" ADD CONSTRAINT "TicketEvent_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketEvent" ADD CONSTRAINT "TicketEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "TicketEvent"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "TicketDraft"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketAttachment" ADD CONSTRAINT "TicketAttachment_uploaderId_fkey" FOREIGN KEY ("uploaderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketLarkCard" ADD CONSTRAINT "TicketLarkCard_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketLarkMessage" ADD CONSTRAINT "TicketLarkMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketOutboxEvent" ADD CONSTRAINT "TicketOutboxEvent_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketDraft" ADD CONSTRAINT "TicketDraft_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketDraft" ADD CONSTRAINT "TicketDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketDraft" ADD CONSTRAINT "TicketDraft_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketDigest" ADD CONSTRAINT "TicketDigest_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- CreateTable
CREATE TABLE "TicketInboundMessage" (
    "messageId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketInboundMessage_pkey" PRIMARY KEY ("messageId")
);
