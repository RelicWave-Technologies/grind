ALTER TABLE "WorkspacePolicy"
  ADD COLUMN "defaultScreenshotIntervalMin" INTEGER NOT NULL DEFAULT 180,
  ADD COLUMN "defaultIdleThresholdMin" INTEGER NOT NULL DEFAULT 5;
