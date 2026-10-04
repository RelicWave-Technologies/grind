-- Attendance rules: thresholds and the date they start judging days, kept on the
-- leave policy because a day that falls short is charged to the leave balance.
-- attendanceRulesFrom stays NULL here: switching the rules on is a decision, not
-- a migration side effect.
ALTER TABLE "LeavePolicy" ADD COLUMN "attendanceRulesFrom" TEXT;
ALTER TABLE "LeavePolicy" ADD COLUMN "fullDayMinMinutes" INTEGER NOT NULL DEFAULT 420;
ALTER TABLE "LeavePolicy" ADD COLUMN "halfDayMinMinutes" INTEGER NOT NULL DEFAULT 210;
ALTER TABLE "LeavePolicy" ADD COLUMN "wfhRequiresApproval" BOOLEAN NOT NULL DEFAULT true;

-- Work-from-home requests mirrored from Lark's "Work From Home Request" approval.
CREATE TABLE "WfhRequest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "LeaveRequestStatus" NOT NULL DEFAULT 'PENDING',
    "appliedAt" TIMESTAMP(3),
    "larkInstanceCode" TEXT NOT NULL,
    "larkApprovalCode" TEXT,
    "larkSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WfhRequest_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WfhRequest_larkInstanceCode_key" ON "WfhRequest"("larkInstanceCode");
CREATE INDEX "WfhRequest_workspaceId_startDate_endDate_idx" ON "WfhRequest"("workspaceId", "startDate", "endDate");
CREATE INDEX "WfhRequest_userId_status_idx" ON "WfhRequest"("userId", "status");

ALTER TABLE "WfhRequest" ADD CONSTRAINT "WfhRequest_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WfhRequest" ADD CONSTRAINT "WfhRequest_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
