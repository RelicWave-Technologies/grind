-- Store the latest local desktop permission health reported by the Timo agent.
-- Fields are nullable for backward compatibility with already-installed agents.
ALTER TABLE "User"
  ADD COLUMN "agentScreenPermissionStatus" TEXT,
  ADD COLUMN "agentScreenCaptureHealth" TEXT,
  ADD COLUMN "agentScreenPermissionState" TEXT,
  ADD COLUMN "agentAccessibilityTrusted" BOOLEAN,
  ADD COLUMN "agentAccessibilityReady" BOOLEAN,
  ADD COLUMN "agentAccessibilityRecording" BOOLEAN,
  ADD COLUMN "agentAccessibilityCapturing" BOOLEAN,
  ADD COLUMN "agentAccessibilityHookRunning" BOOLEAN,
  ADD COLUMN "agentPermissionsUpdatedAt" TIMESTAMP(3);
