-- M45: leave, company holidays and paid-leave balances.
--
-- Everything is measured in days on a 0.5 grid. `days` columns are double
-- precision because every value is a multiple of 0.5, which is exact in binary
-- floating point.

CREATE TYPE "LeavePortion" AS ENUM ('FULL', 'FIRST_HALF', 'SECOND_HALF');
CREATE TYPE "LeaveKind" AS ENUM ('PAID', 'UNPAID');
CREATE TYPE "LeaveRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');
CREATE TYPE "LeaveDecisionSource" AS ENUM ('LARK_APPROVAL', 'DASHBOARD', 'REQUESTER_CANCEL');
CREATE TYPE "LeaveLedgerKind" AS ENUM ('ACCRUAL', 'CONSUMPTION', 'ADJUSTMENT');

-- Paid-leave accrual anchor. NULL falls back to User.createdAt.
ALTER TABLE "User" ADD COLUMN "joinedOn" DATE;

CREATE TABLE "LeavePolicy" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "monthlyAccrualDays" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "carryForward" BOOLEAN NOT NULL DEFAULT true,
    "carryForwardCapDays" DOUBLE PRECISION,
    "allowNegativeBalance" BOOLEAN NOT NULL DEFAULT false,
    "accrueOnJoinMonth" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LeavePolicy_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LeavePolicy_workspaceId_key" ON "LeavePolicy"("workspaceId");
ALTER TABLE "LeavePolicy" ADD CONSTRAINT "LeavePolicy_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CompanyHoliday" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "teamId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CompanyHoliday_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CompanyHoliday_workspaceId_date_teamId_key" ON "CompanyHoliday"("workspaceId", "date", "teamId");
CREATE INDEX "CompanyHoliday_workspaceId_date_idx" ON "CompanyHoliday"("workspaceId", "date");
ALTER TABLE "CompanyHoliday" ADD CONSTRAINT "CompanyHoliday_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompanyHoliday" ADD CONSTRAINT "CompanyHoliday_teamId_fkey"
    FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompanyHoliday" ADD CONSTRAINT "CompanyHoliday_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "LeaveRequest" (
    "id" TEXT NOT NULL,
    "clientUuid" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "LeaveKind" NOT NULL DEFAULT 'PAID',
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "portion" "LeavePortion" NOT NULL DEFAULT 'FULL',
    "chargedDays" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "status" "LeaveRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decisionSource" "LeaveDecisionSource",
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedReason" TEXT,
    "larkInstanceCode" TEXT,
    "larkApprovalCode" TEXT,
    "larkSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LeaveRequest_clientUuid_key" ON "LeaveRequest"("clientUuid");
CREATE UNIQUE INDEX "LeaveRequest_larkInstanceCode_key" ON "LeaveRequest"("larkInstanceCode");
CREATE INDEX "LeaveRequest_workspaceId_status_idx" ON "LeaveRequest"("workspaceId", "status");
CREATE INDEX "LeaveRequest_userId_status_idx" ON "LeaveRequest"("userId", "status");
CREATE INDEX "LeaveRequest_workspaceId_startDate_endDate_idx" ON "LeaveRequest"("workspaceId", "startDate", "endDate");
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeaveRequest" ADD CONSTRAINT "LeaveRequest_decidedById_fkey"
    FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "LeaveLedgerEntry" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "LeaveLedgerKind" NOT NULL,
    "days" DOUBLE PRECISION NOT NULL,
    "effectiveOn" DATE NOT NULL,
    "sourceKey" TEXT NOT NULL,
    "reason" TEXT,
    "requestId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeaveLedgerEntry_pkey" PRIMARY KEY ("id")
);
-- The key that makes a retried accrual or a double-clicked approval a no-op.
CREATE UNIQUE INDEX "LeaveLedgerEntry_sourceKey_key" ON "LeaveLedgerEntry"("sourceKey");
CREATE INDEX "LeaveLedgerEntry_userId_effectiveOn_idx" ON "LeaveLedgerEntry"("userId", "effectiveOn");
CREATE INDEX "LeaveLedgerEntry_workspaceId_effectiveOn_idx" ON "LeaveLedgerEntry"("workspaceId", "effectiveOn");
CREATE INDEX "LeaveLedgerEntry_requestId_idx" ON "LeaveLedgerEntry"("requestId");
ALTER TABLE "LeaveLedgerEntry" ADD CONSTRAINT "LeaveLedgerEntry_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeaveLedgerEntry" ADD CONSTRAINT "LeaveLedgerEntry_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeaveLedgerEntry" ADD CONSTRAINT "LeaveLedgerEntry_requestId_fkey"
    FOREIGN KEY ("requestId") REFERENCES "LeaveRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LeaveLedgerEntry" ADD CONSTRAINT "LeaveLedgerEntry_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
