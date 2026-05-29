-- DropForeignKey
ALTER TABLE "TimeEntry" DROP CONSTRAINT "TimeEntry_projectId_fkey";

-- AlterTable
ALTER TABLE "TimeEntry" ALTER COLUMN "projectId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "TimeEntry" ADD CONSTRAINT "TimeEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
