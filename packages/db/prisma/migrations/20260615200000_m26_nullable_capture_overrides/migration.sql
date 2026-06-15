-- Per-member capture settings become NULLABLE overrides: NULL = inherit the
-- workspace policy default; a value = explicit per-member override.
ALTER TABLE "User"
    ALTER COLUMN "screenshotIntervalMin" DROP DEFAULT,
    ALTER COLUMN "screenshotIntervalMin" DROP NOT NULL,
    ALTER COLUMN "idleThresholdMin" DROP DEFAULT,
    ALTER COLUMN "idleThresholdMin" DROP NOT NULL;

-- Rows that still hold the OLD hardcoded defaults (180 min / 5 min) were never
-- intentional overrides — clear them so those members inherit policy. Genuine
-- overrides (any other value) are preserved.
UPDATE "User" SET "screenshotIntervalMin" = NULL WHERE "screenshotIntervalMin" = 180;
UPDATE "User" SET "idleThresholdMin" = NULL WHERE "idleThresholdMin" = 5;
