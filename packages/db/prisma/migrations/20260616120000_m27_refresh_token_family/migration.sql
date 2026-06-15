-- Refresh-token rotation families for reuse detection (OAuth 2.0 BCP).
-- Every token minted by rotating an earlier one inherits the same familyId;
-- presenting an already-revoked token revokes the entire family.

-- 1. Add nullable, backfill each existing token as its own family, then enforce.
ALTER TABLE "RefreshToken" ADD COLUMN "familyId" TEXT;
UPDATE "RefreshToken" SET "familyId" = "id" WHERE "familyId" IS NULL;
ALTER TABLE "RefreshToken" ALTER COLUMN "familyId" SET NOT NULL;

CREATE INDEX "RefreshToken_familyId_idx" ON "RefreshToken"("familyId");
