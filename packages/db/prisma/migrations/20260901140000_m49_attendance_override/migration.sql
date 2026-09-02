-- M49: a human's correction to a day's attendance status.
--
-- The month performance report derives a status from two sources: the Lark-fed
-- Working Calendar (holiday, weekly off, leave) and Timo's tracked time. Both
-- can be wrong about a real day. An agent that died at 15:37 leaves an eight-
-- hour day reading A; a leave approved outside Lark never arrives at all.
--
-- So a manager or admin can say what a day WAS, and that answer wins. Only the
-- codes a person actually corrects are settable: HOLIDAY and WEEKLY_OFF come
-- from the company calendar and the shift, and letting them be typed here
-- would give the same fact two homes.
CREATE TYPE "AttendanceOverrideCode" AS ENUM ('P', 'A', 'HD', 'PL', 'LWP');

CREATE TABLE "AttendanceOverride" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    -- Business date in the workspace timezone — a date, not an instant.
    "date" DATE NOT NULL,
    "code" "AttendanceOverrideCode" NOT NULL,
    -- Required. Three months later, "why" is the only question anybody asks.
    "reason" TEXT NOT NULL,
    -- What the report said at the moment the override was written. Kept so a
    -- later change underneath — leave arriving from Lark, time syncing late —
    -- is detectable: if today's computed answer no longer matches this, the
    -- override is standing on ground that has moved, and the report flags it
    -- rather than quietly disagreeing with the calendar.
    "computedCode" TEXT,
    "setById" TEXT,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AttendanceOverride_pkey" PRIMARY KEY ("id")
);

-- One correction per person per day: setting it again replaces the decision
-- rather than stacking a second one nobody can order.
CREATE UNIQUE INDEX "AttendanceOverride_userId_date_key" ON "AttendanceOverride"("userId", "date");
CREATE INDEX "AttendanceOverride_workspaceId_date_idx" ON "AttendanceOverride"("workspaceId", "date");

ALTER TABLE "AttendanceOverride" ADD CONSTRAINT "AttendanceOverride_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendanceOverride" ADD CONSTRAINT "AttendanceOverride_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- The author is kept for audit, but deleting a person must not delete the
-- correction they made to somebody else's month.
ALTER TABLE "AttendanceOverride" ADD CONSTRAINT "AttendanceOverride_setById_fkey"
    FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
