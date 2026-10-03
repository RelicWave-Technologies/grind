-- Per-person attendance rule mode. Everyone starts STANDARD; an admin marks
-- remote workers (no punch expected) and people outside the rules by hand.
CREATE TYPE "AttendanceRuleMode" AS ENUM ('STANDARD', 'REMOTE', 'EXEMPT');
ALTER TABLE "User" ADD COLUMN "attendanceRuleMode" "AttendanceRuleMode" NOT NULL DEFAULT 'STANDARD';
