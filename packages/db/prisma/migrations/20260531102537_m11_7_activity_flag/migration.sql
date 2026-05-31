-- CreateEnum
CREATE TYPE "FlagType" AS ENUM ('IMPOSSIBLE_RATE', 'METRONOMIC', 'LINEAR_MOUSE', 'SINGLE_CHANNEL', 'JIGGLER');

-- CreateEnum
CREATE TYPE "FlagStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "FlagResolution" AS ENUM ('DISMISSED', 'CONFIRMED', 'TIME_INVALIDATED');

-- CreateTable
CREATE TABLE "ActivityFlag" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "FlagType" NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "riskScore" INTEGER NOT NULL,
    "evidence" JSONB NOT NULL,
    "status" "FlagStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" "FlagResolution",
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolvedNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityFlag_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActivityFlag_userId_status_idx" ON "ActivityFlag"("userId", "status");

-- CreateIndex
CREATE INDEX "ActivityFlag_status_createdAt_idx" ON "ActivityFlag"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ActivityFlag_userId_windowStart_type_key" ON "ActivityFlag"("userId", "windowStart", "type");

-- AddForeignKey
ALTER TABLE "ActivityFlag" ADD CONSTRAINT "ActivityFlag_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityFlag" ADD CONSTRAINT "ActivityFlag_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
