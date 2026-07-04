-- Robust manual-time approval projections:
-- DB state remains the source of truth; Lark cards are durable, retryable
-- projections with explicit request versions.

CREATE TYPE "ManualTimeDecisionSource" AS ENUM (
  'LARK_CARD',
  'DASHBOARD',
  'REQUESTER_CANCEL',
  'MANAGER_CANCEL',
  'AUTO_APPROVE',
  'ADMIN_REOPEN'
);

CREATE TYPE "ManualTimeLarkMessageKind" AS ENUM (
  'APPROVAL',
  'UPDATED_APPROVAL',
  'DECIDED_NOTICE'
);

CREATE TYPE "ManualTimeLarkMessageStatus" AS ENUM (
  'PENDING',
  'SENT',
  'SEND_FAILED',
  'UPDATE_FAILED',
  'SUPERSEDED',
  'CANCELLED',
  'DECIDED',
  'STALE'
);

CREATE TYPE "ManualTimeLarkOutboxKind" AS ENUM (
  'SEND_CARD',
  'SUPERSEDE_OLD_CARDS',
  'FINALIZE_CARDS'
);

CREATE TYPE "ManualTimeLarkOutboxStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'DONE',
  'FAILED'
);

ALTER TABLE "ManualTimeRequest"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "decidedById" TEXT,
  ADD COLUMN "decisionSource" "ManualTimeDecisionSource";

UPDATE "ManualTimeRequest"
SET "decisionSource" =
  CASE
    WHEN "autoApproved" = true THEN 'AUTO_APPROVE'::"ManualTimeDecisionSource"
    WHEN "status" = 'CANCELLED' THEN 'REQUESTER_CANCEL'::"ManualTimeDecisionSource"
    WHEN "status" IN ('APPROVED', 'REJECTED') THEN 'DASHBOARD'::"ManualTimeDecisionSource"
    ELSE NULL
  END
WHERE "decisionSource" IS NULL;

CREATE TABLE "ManualTimeLarkMessage" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "recipientOpenId" TEXT NOT NULL,
  "messageId" TEXT,
  "kind" "ManualTimeLarkMessageKind" NOT NULL,
  "status" "ManualTimeLarkMessageStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "sentAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ManualTimeLarkMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ManualTimeLarkOutboxEvent" (
  "id" TEXT NOT NULL,
  "requestId" TEXT NOT NULL,
  "messageLedgerId" TEXT,
  "kind" "ManualTimeLarkOutboxKind" NOT NULL,
  "status" "ManualTimeLarkOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "payload" JSONB NOT NULL DEFAULT '{}',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "lockedBy" TEXT,
  "lastError" TEXT,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ManualTimeLarkOutboxEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ManualTimeLarkMessage_messageId_key" ON "ManualTimeLarkMessage"("messageId");
CREATE INDEX "ManualTimeRequest_status_version_idx" ON "ManualTimeRequest"("status", "version");
CREATE INDEX "ManualTimeLarkMessage_requestId_version_idx" ON "ManualTimeLarkMessage"("requestId", "version");
CREATE INDEX "ManualTimeLarkMessage_requestId_status_idx" ON "ManualTimeLarkMessage"("requestId", "status");
CREATE INDEX "ManualTimeLarkMessage_status_updatedAt_idx" ON "ManualTimeLarkMessage"("status", "updatedAt");
CREATE INDEX "ManualTimeLarkOutboxEvent_status_nextRunAt_createdAt_idx" ON "ManualTimeLarkOutboxEvent"("status", "nextRunAt", "createdAt");
CREATE INDEX "ManualTimeLarkOutboxEvent_requestId_idx" ON "ManualTimeLarkOutboxEvent"("requestId");
CREATE INDEX "ManualTimeLarkOutboxEvent_messageLedgerId_idx" ON "ManualTimeLarkOutboxEvent"("messageLedgerId");

ALTER TABLE "ManualTimeRequest"
  ADD CONSTRAINT "ManualTimeRequest_decidedById_fkey"
  FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "ManualTimeLarkMessage"
  ADD CONSTRAINT "ManualTimeLarkMessage_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "ManualTimeRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ManualTimeLarkOutboxEvent"
  ADD CONSTRAINT "ManualTimeLarkOutboxEvent_requestId_fkey"
  FOREIGN KEY ("requestId") REFERENCES "ManualTimeRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ManualTimeLarkOutboxEvent"
  ADD CONSTRAINT "ManualTimeLarkOutboxEvent_messageLedgerId_fkey"
  FOREIGN KEY ("messageLedgerId") REFERENCES "ManualTimeLarkMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "ManualTimeLarkMessage" (
  "id",
  "requestId",
  "version",
  "recipientOpenId",
  "messageId",
  "kind",
  "status",
  "sentAt",
  "createdAt",
  "updatedAt"
)
SELECT
  'mtrl_' || "ManualTimeRequest"."id",
  "ManualTimeRequest"."id",
  1,
  COALESCE("LarkIdentity"."openId", 'unknown'),
  "ManualTimeRequest"."larkMessageId",
  CASE
    WHEN "ManualTimeRequest"."status" IN ('APPROVED', 'REJECTED') THEN 'DECIDED_NOTICE'::"ManualTimeLarkMessageKind"
    ELSE 'APPROVAL'::"ManualTimeLarkMessageKind"
  END,
  CASE
    WHEN "ManualTimeRequest"."status" = 'CANCELLED' THEN 'CANCELLED'::"ManualTimeLarkMessageStatus"
    WHEN "ManualTimeRequest"."status" IN ('APPROVED', 'REJECTED') THEN 'DECIDED'::"ManualTimeLarkMessageStatus"
    ELSE 'SENT'::"ManualTimeLarkMessageStatus"
  END,
  COALESCE("ManualTimeRequest"."decidedAt", "ManualTimeRequest"."createdAt"),
  "ManualTimeRequest"."createdAt",
  "ManualTimeRequest"."updatedAt"
FROM "ManualTimeRequest"
LEFT JOIN "User" AS "Approver" ON "Approver"."id" = "ManualTimeRequest"."approverId"
LEFT JOIN "LarkIdentity" ON "LarkIdentity"."userId" = "Approver"."id"
WHERE "ManualTimeRequest"."larkMessageId" IS NOT NULL;
