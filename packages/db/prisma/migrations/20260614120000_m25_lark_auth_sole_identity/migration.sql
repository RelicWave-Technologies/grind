-- CreateEnum
CREATE TYPE "ProvisioningStatus" AS ENUM ('PENDING', 'ACTIVE');

-- AlterTable: passwordHash becomes nullable (Lark OAuth is the sole identity),
-- and add provisioning + avatar fields. Existing rows (if any) default to
-- ACTIVE so we never lock out a pre-existing user; new Lark users are PENDING
-- via the Prisma default at insert time.
ALTER TABLE "User"
    ALTER COLUMN "passwordHash" DROP NOT NULL,
    ADD COLUMN "provisioningStatus" "ProvisioningStatus" NOT NULL DEFAULT 'ACTIVE',
    ADD COLUMN "avatarUrl" TEXT;

-- Realign the column default with the Prisma model (PENDING) for future inserts,
-- after the ACTIVE backfill above has applied to existing rows.
ALTER TABLE "User" ALTER COLUMN "provisioningStatus" SET DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "AgentAuthCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "challenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentAuthCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentAuthCode_codeHash_key" ON "AgentAuthCode"("codeHash");

-- CreateIndex
CREATE INDEX "AgentAuthCode_userId_idx" ON "AgentAuthCode"("userId");

-- AddForeignKey
ALTER TABLE "AgentAuthCode" ADD CONSTRAINT "AgentAuthCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
