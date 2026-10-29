-- CreateEnum
CREATE TYPE "AccessRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "AccessDecisionSource" AS ENUM ('LARK_CARD', 'DASHBOARD');

-- CreateEnum
CREATE TYPE "AccessRequestLarkMessageStatus" AS ENUM ('PENDING', 'SENT', 'SEND_FAILED', 'UPDATE_FAILED', 'DECIDED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "AccessRequestLarkOutboxKind" AS ENUM ('SEND_CARDS', 'FINALIZE_CARDS');

-- AlterTable
ALTER TABLE "WorkspacePolicy" ADD COLUMN     "accessRequestRecipientIds" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "AccessRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "AccessRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedVia" "AccessDecisionSource",
    "decidedAt" TIMESTAMP(3),
    "teamId" TEXT,
    "shiftId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessRequestLarkMessage" (
    "id" TEXT NOT NULL,
    "accessRequestId" TEXT NOT NULL,
    "recipientOpenId" TEXT NOT NULL,
    "messageId" TEXT,
    "status" "AccessRequestLarkMessageStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessRequestLarkMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessRequestLarkOutboxEvent" (
    "id" TEXT NOT NULL,
    "accessRequestId" TEXT NOT NULL,
    "kind" "AccessRequestLarkOutboxKind" NOT NULL,
    "status" "ManualTimeLarkOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastError" TEXT,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccessRequestLarkOutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AccessRequest_userId_key" ON "AccessRequest"("userId");

-- CreateIndex
CREATE INDEX "AccessRequest_status_idx" ON "AccessRequest"("status");

-- CreateIndex
CREATE UNIQUE INDEX "AccessRequestLarkMessage_messageId_key" ON "AccessRequestLarkMessage"("messageId");

-- CreateIndex
CREATE INDEX "AccessRequestLarkMessage_status_updatedAt_idx" ON "AccessRequestLarkMessage"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AccessRequestLarkMessage_accessRequestId_recipientOpenId_key" ON "AccessRequestLarkMessage"("accessRequestId", "recipientOpenId");

-- CreateIndex
CREATE INDEX "AccessRequestLarkOutboxEvent_status_nextRunAt_createdAt_idx" ON "AccessRequestLarkOutboxEvent"("status", "nextRunAt", "createdAt");

-- CreateIndex
CREATE INDEX "AccessRequestLarkOutboxEvent_accessRequestId_idx" ON "AccessRequestLarkOutboxEvent"("accessRequestId");

-- AddForeignKey
ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessRequest" ADD CONSTRAINT "AccessRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessRequestLarkMessage" ADD CONSTRAINT "AccessRequestLarkMessage_accessRequestId_fkey" FOREIGN KEY ("accessRequestId") REFERENCES "AccessRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccessRequestLarkOutboxEvent" ADD CONSTRAINT "AccessRequestLarkOutboxEvent_accessRequestId_fkey" FOREIGN KEY ("accessRequestId") REFERENCES "AccessRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

