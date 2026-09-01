-- Extra paid-leave days granted on a person's birthday, once a year.
-- Default 0: off unless a workspace asks for it.
ALTER TABLE "LeavePolicy" ADD COLUMN "birthdayLeaveDays" DOUBLE PRECISION NOT NULL DEFAULT 0;
