/*
  Warnings:

  - You are about to drop the column `projectId` on the `ManualTimeRequest` table. All the data in the column will be lost.
  - You are about to drop the column `projectId` on the `TimeEntry` table. All the data in the column will be lost.
  - You are about to drop the column `taskId` on the `TimeEntry` table. All the data in the column will be lost.
  - You are about to drop the `Project` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Task` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "ManualTimeRequest" DROP CONSTRAINT "ManualTimeRequest_projectId_fkey";

-- DropForeignKey
ALTER TABLE "Project" DROP CONSTRAINT "Project_workspaceId_fkey";

-- DropForeignKey
ALTER TABLE "Task" DROP CONSTRAINT "Task_projectId_fkey";

-- DropForeignKey
ALTER TABLE "TimeEntry" DROP CONSTRAINT "TimeEntry_projectId_fkey";

-- DropForeignKey
ALTER TABLE "TimeEntry" DROP CONSTRAINT "TimeEntry_taskId_fkey";

-- DropIndex
DROP INDEX "TimeEntry_projectId_startedAt_idx";

-- DropIndex
DROP INDEX "TimeEntry_taskId_idx";

-- AlterTable
ALTER TABLE "ManualTimeRequest" DROP COLUMN "projectId";

-- AlterTable
ALTER TABLE "TimeEntry" DROP COLUMN "projectId",
DROP COLUMN "taskId";

-- DropTable
DROP TABLE "Project";

-- DropTable
DROP TABLE "Task";

-- CreateIndex
CREATE INDEX "TimeEntry_larkTaskGuid_idx" ON "TimeEntry"("larkTaskGuid");
