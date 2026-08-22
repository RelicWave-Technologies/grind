-- M48: punch in / punch out, recorded externally.
--
-- Timo already knows the first and last segment boundary of a day, and the
-- reports briefly showed that as "punch in / punch out". The two answer
-- different questions: activity says when the laptop started working, a punch
-- says when the person was recorded at the door. They disagree often enough
-- that collapsing them hides the disagreement, which is usually the point.
--
-- So punches get their own table, written from outside Timo. Times are stored
-- as TIME, not TIMESTAMP: they are clock readings local to the workspace
-- timezone, and nothing should convert them on the way in or out.
CREATE TABLE "AttendancePunch" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "punchInAt" TIME(3),
    "punchOutAt" TIME(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AttendancePunch_pkey" PRIMARY KEY ("id")
);

-- One row per person per day, so re-running an import upserts instead of
-- duplicating. Unlike CompanyHoliday's nullable teamId, both columns here are
-- NOT NULL, so Postgres NULL-distinctness cannot defeat this constraint.
CREATE UNIQUE INDEX "AttendancePunch_userId_date_key" ON "AttendancePunch"("userId", "date");
CREATE INDEX "AttendancePunch_workspaceId_date_idx" ON "AttendancePunch"("workspaceId", "date");

ALTER TABLE "AttendancePunch" ADD CONSTRAINT "AttendancePunch_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AttendancePunch" ADD CONSTRAINT "AttendancePunch_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
