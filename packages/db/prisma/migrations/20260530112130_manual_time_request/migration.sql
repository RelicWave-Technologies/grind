-- CreateEnum
CREATE TYPE "ManualTimeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "ManualTimeRequest" (
    "id" TEXT NOT NULL,
    "clientUuid" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "projectId" TEXT,
    "larkTaskGuid" TEXT,
    "requestedStart" TIMESTAMP(3) NOT NULL,
    "requestedEnd" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "ManualTimeRequestStatus" NOT NULL DEFAULT 'PENDING',
    "approverId" TEXT,
    "larkMessageId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedReason" TEXT,
    "timeEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ManualTimeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ManualTimeRequest_clientUuid_key" ON "ManualTimeRequest"("clientUuid");

-- CreateIndex
CREATE UNIQUE INDEX "ManualTimeRequest_timeEntryId_key" ON "ManualTimeRequest"("timeEntryId");

-- CreateIndex
CREATE INDEX "ManualTimeRequest_userId_status_idx" ON "ManualTimeRequest"("userId", "status");

-- CreateIndex
CREATE INDEX "ManualTimeRequest_approverId_status_idx" ON "ManualTimeRequest"("approverId", "status");

-- AddForeignKey
ALTER TABLE "ManualTimeRequest" ADD CONSTRAINT "ManualTimeRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualTimeRequest" ADD CONSTRAINT "ManualTimeRequest_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualTimeRequest" ADD CONSTRAINT "ManualTimeRequest_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ManualTimeRequest" ADD CONSTRAINT "ManualTimeRequest_timeEntryId_fkey" FOREIGN KEY ("timeEntryId") REFERENCES "TimeEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
