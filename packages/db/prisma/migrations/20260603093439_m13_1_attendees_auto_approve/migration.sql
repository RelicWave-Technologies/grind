-- AlterTable
ALTER TABLE "ManualTimeRequest" ADD COLUMN     "autoApproved" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "MtrAttendee" (
    "requestId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MtrAttendee_pkey" PRIMARY KEY ("requestId","userId")
);

-- CreateTable
CREATE TABLE "TimeEntryAttendee" (
    "timeEntryId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TimeEntryAttendee_pkey" PRIMARY KEY ("timeEntryId","userId")
);

-- CreateIndex
CREATE INDEX "MtrAttendee_userId_idx" ON "MtrAttendee"("userId");

-- CreateIndex
CREATE INDEX "TimeEntryAttendee_userId_idx" ON "TimeEntryAttendee"("userId");

-- AddForeignKey
ALTER TABLE "MtrAttendee" ADD CONSTRAINT "MtrAttendee_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "ManualTimeRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MtrAttendee" ADD CONSTRAINT "MtrAttendee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntryAttendee" ADD CONSTRAINT "TimeEntryAttendee_timeEntryId_fkey" FOREIGN KEY ("timeEntryId") REFERENCES "TimeEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TimeEntryAttendee" ADD CONSTRAINT "TimeEntryAttendee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
