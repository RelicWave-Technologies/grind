-- AlterTable
ALTER TABLE "TimeEntry" ADD COLUMN     "shiftIdAtStart" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "shiftAssignedAt" TIMESTAMP(3),
ADD COLUMN     "shiftId" TEXT;

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "schedule" JSONB NOT NULL,
    "bufferMin" INTEGER NOT NULL DEFAULT 30,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shift_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Shift_workspaceId_idx" ON "Shift"("workspaceId");

-- CreateIndex
CREATE INDEX "User_shiftId_idx" ON "User"("shiftId");

-- AddForeignKey
ALTER TABLE "Shift" ADD CONSTRAINT "Shift_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift"("id") ON DELETE SET NULL ON UPDATE CASCADE;
