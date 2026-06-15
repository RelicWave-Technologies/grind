-- Cached real app icons, keyed by bundle id. Workspace-agnostic; agents upload
-- the PNG once per bundle and the insights API inlines it as a data URL.
CREATE TABLE "AppIcon" (
    "bundleId" TEXT NOT NULL,
    "app" TEXT NOT NULL,
    "png" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AppIcon_pkey" PRIMARY KEY ("bundleId")
);
