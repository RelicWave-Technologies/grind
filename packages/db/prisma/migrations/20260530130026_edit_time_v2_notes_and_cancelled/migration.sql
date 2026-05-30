-- AlterEnum
ALTER TYPE "ManualTimeRequestStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "TimeEntry" ADD COLUMN     "notes" TEXT;
