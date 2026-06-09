-- Persist the human Lark task label on manual-time approvals so historical
-- approval rows never need to render an opaque task GUID as user-facing text.
ALTER TABLE "ManualTimeRequest" ADD COLUMN "taskSummary" TEXT;
