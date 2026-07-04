-- Screenshot cadence policy:
--   * valid values are exactly 1, 2, or 3 minutes
--   * workspace default becomes 3 minutes
--   * invalid member overrides become NULL so members inherit workspace policy

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
    "defaultScreenshotIntervalMin",
    "defaultIdleThresholdMin",
    3,
    "defaultIdleThresholdMin",
    CASE
      WHEN "defaultIdleThresholdMin" = 1 THEN 'HIGH'::"MonitoringSettingsRiskLevel"
      WHEN "defaultIdleThresholdMin" <= 3 THEN 'CAUTION'::"MonitoringSettingsRiskLevel"
      ELSE 'NORMAL'::"MonitoringSettingsRiskLevel"
    END,
    'migration_screenshot_interval_options_1_2_3',
    CURRENT_TIMESTAMP
FROM "WorkspacePolicy"
WHERE "defaultScreenshotIntervalMin" NOT IN (1, 2, 3);

UPDATE "WorkspacePolicy"
SET "defaultScreenshotIntervalMin" = 3
WHERE "defaultScreenshotIntervalMin" NOT IN (1, 2, 3);

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
    concat('monaud_', substr(md5(random()::text || clock_timestamp()::text || u."id"), 1, 24)),
    u."workspaceId",
    u."id",
    'MEMBER_OVERRIDE'::"MonitoringSettingsScope",
    u."screenshotIntervalMin",
    COALESCE(u."idleThresholdMin", wp."defaultIdleThresholdMin", 5),
    COALESCE(wp."defaultScreenshotIntervalMin", 3),
    COALESCE(u."idleThresholdMin", wp."defaultIdleThresholdMin", 5),
    CASE
      WHEN COALESCE(wp."defaultScreenshotIntervalMin", 3) = 1
        OR COALESCE(u."idleThresholdMin", wp."defaultIdleThresholdMin", 5) = 1
        THEN 'HIGH'::"MonitoringSettingsRiskLevel"
      WHEN COALESCE(wp."defaultScreenshotIntervalMin", 3) = 2
        OR COALESCE(u."idleThresholdMin", wp."defaultIdleThresholdMin", 5) <= 3
        THEN 'CAUTION'::"MonitoringSettingsRiskLevel"
      ELSE 'NORMAL'::"MonitoringSettingsRiskLevel"
    END,
    'migration_screenshot_interval_options_1_2_3',
    CURRENT_TIMESTAMP
FROM "User" u
LEFT JOIN "WorkspacePolicy" wp ON wp."workspaceId" = u."workspaceId"
WHERE u."screenshotIntervalMin" IS NOT NULL
  AND u."screenshotIntervalMin" NOT IN (1, 2, 3);

UPDATE "User"
SET "screenshotIntervalMin" = NULL
WHERE "screenshotIntervalMin" IS NOT NULL
  AND "screenshotIntervalMin" NOT IN (1, 2, 3);

ALTER TABLE "WorkspacePolicy"
  ALTER COLUMN "defaultScreenshotIntervalMin" SET DEFAULT 3;

ALTER TABLE "WorkspacePolicy"
  ADD CONSTRAINT "WorkspacePolicy_defaultScreenshotIntervalMin_allowed_check"
  CHECK ("defaultScreenshotIntervalMin" IN (1, 2, 3));

ALTER TABLE "User"
  ADD CONSTRAINT "User_screenshotIntervalMin_allowed_check"
  CHECK ("screenshotIntervalMin" IS NULL OR "screenshotIntervalMin" IN (1, 2, 3));
