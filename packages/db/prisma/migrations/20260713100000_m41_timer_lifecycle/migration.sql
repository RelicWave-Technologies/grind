-- Additive timer lifecycle metadata. Existing rows remain legacy (NULL protocol)
-- and are not rewritten or finalized by this migration.
CREATE TYPE "TimeEntryCloseReason" AS ENUM (
  'AGENT',
  'AGENT_RECOVERY',
  'LEASE_EXPIRED',
  'SUPERSEDED',
  'LEGACY_RECONCILED'
);

ALTER TABLE "TimeEntry"
  ADD COLUMN "trackingProtocolVersion" INTEGER,
  ADD COLUMN "agentRevision" INTEGER,
  ADD COLUMN "lastProvenAt" TIMESTAMP(3),
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "closeReason" "TimeEntryCloseReason",
  ADD COLUMN "serverFinalizedAt" TIMESTAMP(3);

CREATE INDEX "TimeEntry_trackingProtocolVersion_endedAt_leaseExpiresAt_idx"
  ON "TimeEntry"("trackingProtocolVersion", "endedAt", "leaseExpiresAt");
