-- Auto-update health reported by the desktop agent heartbeat (beta.38+).
-- Additive and nullable: older agents never send it.
--   agentInstallScope: 'user' | 'machine' | 'unknown' — a Windows 'machine'
--     install (Program Files) cannot update itself and needs a per-user reinstall.
--   agentUpdateError: last updater failure ("CODE: message"), NULL once a check succeeds.
ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "agentInstallScope" TEXT,
  ADD COLUMN IF NOT EXISTS "agentUpdateError" TEXT;
