-- CreateEnum
CREATE TYPE "ActivityRoleTitle" AS ENUM ('DEVELOPER', 'DESIGNER', 'SALES', 'OTHER');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "activityRoleTitle" "ActivityRoleTitle" NOT NULL DEFAULT 'OTHER';

-- CreateTable
CREATE TABLE "TimeInvalidation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "flagId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "invalidatedById" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeInvalidation_pkey" PRIMARY KEY ("id")
);

-- Backfill any historical verdict-only invalidations so the new aggregation
-- layer immediately honors them.
INSERT INTO "TimeInvalidation" (
    "id",
    "workspaceId",
    "flagId",
    "userId",
    "windowStart",
    "windowEnd",
    "invalidatedById",
    "reason",
    "createdAt"
)
SELECT
    'ti_' || "ActivityFlag"."id",
    "User"."workspaceId",
    "ActivityFlag"."id",
    "ActivityFlag"."userId",
    "ActivityFlag"."windowStart",
    "ActivityFlag"."windowEnd",
    "ActivityFlag"."resolvedById",
    COALESCE(NULLIF(BTRIM("ActivityFlag"."resolvedNote"), ''), 'Backfilled from TIME_INVALIDATED flag resolution'),
    COALESCE("ActivityFlag"."resolvedAt", "ActivityFlag"."createdAt")
FROM "ActivityFlag"
JOIN "User" ON "User"."id" = "ActivityFlag"."userId"
WHERE "ActivityFlag"."status" = 'RESOLVED'
  AND "ActivityFlag"."resolution" = 'TIME_INVALIDATED';

-- CreateIndex
CREATE UNIQUE INDEX "TimeInvalidation_flagId_key" ON "TimeInvalidation"("flagId");

-- CreateIndex
CREATE INDEX "TimeInvalidation_workspaceId_windowStart_idx" ON "TimeInvalidation"("workspaceId", "windowStart");

-- CreateIndex
CREATE INDEX "TimeInvalidation_userId_windowStart_idx" ON "TimeInvalidation"("userId", "windowStart");

-- AddForeignKey
ALTER TABLE "TimeInvalidation" ADD CONSTRAINT "TimeInvalidation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeInvalidation" ADD CONSTRAINT "TimeInvalidation_flagId_fkey" FOREIGN KEY ("flagId") REFERENCES "ActivityFlag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeInvalidation" ADD CONSTRAINT "TimeInvalidation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeInvalidation" ADD CONSTRAINT "TimeInvalidation_invalidatedById_fkey" FOREIGN KEY ("invalidatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
