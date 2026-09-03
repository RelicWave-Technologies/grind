-- Every correction ever made to a person-day, including the removals.
-- AttendanceOverride keeps the decision in force; this keeps how it got there.
CREATE TABLE "AttendanceOverrideEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "code" "AttendanceOverrideCode",
    "reason" TEXT NOT NULL,
    "computedCode" TEXT,
    "setById" TEXT,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AttendanceOverrideEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AttendanceOverrideEvent_userId_date_setAt_idx"
    ON "AttendanceOverrideEvent"("userId", "date", "setAt");
CREATE INDEX "AttendanceOverrideEvent_workspaceId_date_idx"
    ON "AttendanceOverrideEvent"("workspaceId", "date");

ALTER TABLE "AttendanceOverrideEvent" ADD CONSTRAINT "AttendanceOverrideEvent_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendanceOverrideEvent" ADD CONSTRAINT "AttendanceOverrideEvent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendanceOverrideEvent" ADD CONSTRAINT "AttendanceOverrideEvent_setById_fkey"
    FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- The corrections already made, so the log does not start empty and pretend
-- nobody had decided anything before today.
INSERT INTO "AttendanceOverrideEvent" ("id", "workspaceId", "userId", "date", "code", "reason", "computedCode", "setById", "setAt")
SELECT "id", "workspaceId", "userId", "date", "code", "reason", "computedCode", "setById", "setAt"
FROM "AttendanceOverride";
