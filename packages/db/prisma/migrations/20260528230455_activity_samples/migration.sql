-- CreateTable
CREATE TABLE "ActivitySample" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "timeEntryId" TEXT,
    "bucketStart" TIMESTAMP(3) NOT NULL,
    "keystrokes" INTEGER NOT NULL,
    "clicks" INTEGER NOT NULL,
    "mouseDistancePx" INTEGER NOT NULL,
    "scrollEvents" INTEGER NOT NULL,
    "ikiCv" DOUBLE PRECISION,
    "moveSpeedCv" DOUBLE PRECISION,
    "pathStraightness" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivitySample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActivitySample_userId_bucketStart_idx" ON "ActivitySample"("userId", "bucketStart");

-- CreateIndex
CREATE INDEX "ActivitySample_timeEntryId_idx" ON "ActivitySample"("timeEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "ActivitySample_userId_bucketStart_key" ON "ActivitySample"("userId", "bucketStart");

-- AddForeignKey
ALTER TABLE "ActivitySample" ADD CONSTRAINT "ActivitySample_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivitySample" ADD CONSTRAINT "ActivitySample_timeEntryId_fkey" FOREIGN KEY ("timeEntryId") REFERENCES "TimeEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
