-- Successor link for refresh-token rotation. Additive and nullable: existing
-- rows keep working, they simply cannot recover a lost rotation response.
ALTER TABLE "RefreshToken" ADD COLUMN IF NOT EXISTS "replacedById" TEXT;
