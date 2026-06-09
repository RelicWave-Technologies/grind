CREATE TYPE "PayrollSheetRecipientMode" AS ENUM ('ALL_ADMINS');

CREATE TYPE "PayrollRunType" AS ENUM ('APPROVAL_REMINDER', 'PAYROLL_SHEET');

CREATE TYPE "PayrollRunStatus" AS ENUM ('SENT', 'PARTIAL', 'FAILED', 'SKIPPED');

CREATE TABLE "PayrollPolicy" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "halfDayLowerMin" INTEGER NOT NULL DEFAULT 240,
    "halfDayUpperMin" INTEGER NOT NULL DEFAULT 480,
    "fullDayLowerMin" INTEGER NOT NULL DEFAULT 480,
    "fullDayUpperMin" INTEGER NOT NULL DEFAULT 600,
    "monthlyLowerMin" INTEGER NOT NULL DEFAULT 9600,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "approvalReminderDays" INTEGER[] NOT NULL DEFAULT ARRAY[3, 4]::INTEGER[],
    "approvalReminderTime" TEXT NOT NULL DEFAULT '00:00',
    "payrollSheetSendDay" INTEGER NOT NULL DEFAULT 5,
    "payrollSheetSendTime" TEXT NOT NULL DEFAULT '00:00',
    "sendPayrollSheetTo" "PayrollSheetRecipientMode" NOT NULL DEFAULT 'ALL_ADMINS',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollPolicy_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PayrollRunLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "runType" "PayrollRunType" NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "status" "PayrollRunStatus" NOT NULL,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "skippedNoLarkCount" INTEGER NOT NULL DEFAULT 0,
    "skippedUnassignedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollRunLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PayrollPolicy_workspaceId_key" ON "PayrollPolicy"("workspaceId");
CREATE UNIQUE INDEX "PayrollRunLog_workspaceId_month_runType_scheduledFor_key" ON "PayrollRunLog"("workspaceId", "month", "runType", "scheduledFor");
CREATE INDEX "PayrollRunLog_workspaceId_month_idx" ON "PayrollRunLog"("workspaceId", "month");

ALTER TABLE "PayrollPolicy" ADD CONSTRAINT "PayrollPolicy_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PayrollRunLog" ADD CONSTRAINT "PayrollRunLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
