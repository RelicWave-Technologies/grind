-- Workspace capture-policy changes (apps / titles / URLs / screenshot
-- retention) are audited alongside timing changes: { field: { from, to } }.
ALTER TABLE "MonitoringSettingsAudit" ADD COLUMN IF NOT EXISTS "policyChanges" JSONB;
