-- Audit aggressive screenshot/idle monitoring settings without rewriting raw
-- tracking data. Existing 1-minute settings are backfilled as pre-audit rows.

CREATE TYPE "MonitoringSettingsScope" AS ENUM ('WORKSPACE_POLICY', 'MEMBER_OVERRIDE');
CREATE TYPE "MonitoringSettingsRiskLevel" AS ENUM ('NORMAL', 'CAUTION', 'HIGH');

CREATE TABLE "MonitoringSettingsAudit" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "actorId" TEXT,
    "targetUserId" TEXT,
    "scope" "MonitoringSettingsScope" NOT NULL,
    "previousScreenshotIntervalMin" INTEGER,
    "previousIdleThresholdMin" INTEGER,
    "nextScreenshotIntervalMin" INTEGER,
    "nextIdleThresholdMin" INTEGER,
    "riskLevel" "MonitoringSettingsRiskLevel" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonitoringSettingsAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "MonitoringSettingsAudit_workspaceId_createdAt_idx" ON "MonitoringSettingsAudit"("workspaceId", "createdAt");
CREATE INDEX "MonitoringSettingsAudit_targetUserId_createdAt_idx" ON "MonitoringSettingsAudit"("targetUserId", "createdAt");
CREATE INDEX "MonitoringSettingsAudit_actorId_createdAt_idx" ON "MonitoringSettingsAudit"("actorId", "createdAt");

ALTER TABLE "MonitoringSettingsAudit"
  ADD CONSTRAINT "MonitoringSettingsAudit_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MonitoringSettingsAudit"
  ADD CONSTRAINT "MonitoringSettingsAudit_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MonitoringSettingsAudit"
  ADD CONSTRAINT "MonitoringSettingsAudit_targetUserId_fkey"
  FOREIGN KEY ("targetUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "MonitoringSettingsAudit" (
    "id",
    "workspaceId",
    "scope",
    "previousScreenshotIntervalMin",
    "previousIdleThresholdMin",
    "nextScreenshotIntervalMin",
    "nextIdleThresholdMin",
    "riskLevel",
    "reason",
    "createdAt"
)
SELECT
    concat('monaud_', substr(md5(random()::text || clock_timestamp()::text || "id"), 1, 24)),
    "workspaceId",
    'WORKSPACE_POLICY'::"MonitoringSettingsScope",
    NULL,
    NULL,
    "defaultScreenshotIntervalMin",
    "defaultIdleThresholdMin",
    'HIGH'::"MonitoringSettingsRiskLevel",
    'pre_audit_existing_high_risk_setting',
    CURRENT_TIMESTAMP
FROM "WorkspacePolicy"
WHERE "defaultScreenshotIntervalMin" = 1 OR "defaultIdleThresholdMin" = 1;

INSERT INTO "MonitoringSettingsAudit" (
    "id",
    "workspaceId",
    "targetUserId",
    "scope",
    "previousScreenshotIntervalMin",
    "previousIdleThresholdMin",
    "nextScreenshotIntervalMin",
    "nextIdleThresholdMin",
    "riskLevel",
    "reason",
    "createdAt"
)
SELECT
    concat('monaud_', substr(md5(random()::text || clock_timestamp()::text || "id"), 1, 24)),
    "workspaceId",
    "id",
    'MEMBER_OVERRIDE'::"MonitoringSettingsScope",
    NULL,
    NULL,
    "screenshotIntervalMin",
    "idleThresholdMin",
    'HIGH'::"MonitoringSettingsRiskLevel",
    'pre_audit_existing_high_risk_setting',
    CURRENT_TIMESTAMP
FROM "User"
WHERE "screenshotIntervalMin" = 1 OR "idleThresholdMin" = 1;
