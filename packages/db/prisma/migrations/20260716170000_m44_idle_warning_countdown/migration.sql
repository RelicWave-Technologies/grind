ALTER TABLE "User"
ADD COLUMN "idleWarningSeconds" INTEGER,
ADD CONSTRAINT "User_idleWarningSeconds_range"
CHECK ("idleWarningSeconds" IS NULL OR "idleWarningSeconds" BETWEEN 5 AND 120);

ALTER TABLE "MonitoringSettingsAudit"
ADD COLUMN "previousIdleWarningSeconds" INTEGER,
ADD COLUMN "nextIdleWarningSeconds" INTEGER;
