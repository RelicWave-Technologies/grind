-- M20: ADMIN is the single top workspace role. Existing OWNER rows are
-- migrated to ADMIN before the PostgreSQL enum is recreated without OWNER.
UPDATE "User" SET "role" = 'ADMIN' WHERE "role" = 'OWNER';

ALTER TYPE "Role" RENAME TO "Role_old";
CREATE TYPE "Role" AS ENUM ('ADMIN', 'MANAGER', 'MEMBER');
ALTER TABLE "User" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "User" ALTER COLUMN "role" TYPE "Role" USING ("role"::text::"Role");
ALTER TABLE "User" ALTER COLUMN "role" SET DEFAULT 'MEMBER';
DROP TYPE "Role_old";

CREATE TYPE "ScreenshotUploadState" AS ENUM ('PENDING', 'UPLOADED', 'FAILED');

CREATE TABLE "ShiftAssignment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "shiftId" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "shiftNameSnapshot" TEXT,
    "scheduleSnapshot" JSONB,
    "bufferMinSnapshot" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShiftAssignment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Screenshot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "timeEntryId" TEXT,
    "displayId" TEXT,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "s3Key" TEXT,
    "thumbS3Key" TEXT,
    "fullUrl" TEXT,
    "thumbUrl" TEXT,
    "bytes" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "phash" BIGINT,
    "uploadState" "ScreenshotUploadState" NOT NULL DEFAULT 'PENDING',
    "blurred" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "deletedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Screenshot_pkey" PRIMARY KEY ("id")
);

INSERT INTO "ShiftAssignment" (
    "id",
    "userId",
    "shiftId",
    "effectiveFrom",
    "shiftNameSnapshot",
    "scheduleSnapshot",
    "bufferMinSnapshot"
)
SELECT
    'shfta_' || md5(u."id" || ':' || COALESCE(u."shiftAssignedAt"::text, u."createdAt"::text)),
    u."id",
    u."shiftId",
    COALESCE(u."shiftAssignedAt", u."createdAt"),
    s."name",
    s."schedule",
    s."bufferMin"
FROM "User" u
JOIN "Shift" s ON s."id" = u."shiftId"
WHERE u."shiftId" IS NOT NULL;

CREATE INDEX "ShiftAssignment_userId_effectiveFrom_idx" ON "ShiftAssignment"("userId", "effectiveFrom");
CREATE INDEX "ShiftAssignment_userId_effectiveTo_idx" ON "ShiftAssignment"("userId", "effectiveTo");
CREATE INDEX "Screenshot_userId_capturedAt_idx" ON "Screenshot"("userId", "capturedAt");
CREATE INDEX "Screenshot_timeEntryId_idx" ON "Screenshot"("timeEntryId");

ALTER TABLE "ShiftAssignment" ADD CONSTRAINT "ShiftAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Screenshot" ADD CONSTRAINT "Screenshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Screenshot" ADD CONSTRAINT "Screenshot_timeEntryId_fkey" FOREIGN KEY ("timeEntryId") REFERENCES "TimeEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Screenshot" ADD CONSTRAINT "Screenshot_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
