-- Team managers are now explicit assignments:
--   * one team can have many managers
--   * one user can manage only one team
--   * non-admin MANAGER role is derived from this table

CREATE TABLE "TeamManager" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamManager_pkey" PRIMARY KEY ("id")
);

INSERT INTO "TeamManager" ("id", "workspaceId", "teamId", "userId", "createdAt")
SELECT
  concat('tm_', md5(t."id" || ':' || t."managerId" || ':' || random()::text)),
  t."workspaceId",
  t."id",
  t."managerId",
  CURRENT_TIMESTAMP
FROM "Team" t
JOIN "User" u ON u."id" = t."managerId" AND u."workspaceId" = t."workspaceId"
WHERE t."managerId" IS NOT NULL
ON CONFLICT DO NOTHING;

-- Recompute system-managed MANAGER roles from TeamManager. ADMIN is never
-- downgraded by team-manager assignment changes.
UPDATE "User" u
SET "role" = 'MANAGER'
WHERE u."role" <> 'ADMIN'
  AND EXISTS (SELECT 1 FROM "TeamManager" tm WHERE tm."userId" = u."id");

UPDATE "User" u
SET "role" = 'MEMBER'
WHERE u."role" = 'MANAGER'
  AND NOT EXISTS (SELECT 1 FROM "TeamManager" tm WHERE tm."userId" = u."id");

CREATE UNIQUE INDEX "TeamManager_teamId_userId_key" ON "TeamManager"("teamId", "userId");
CREATE UNIQUE INDEX "TeamManager_userId_key" ON "TeamManager"("userId");
CREATE INDEX "TeamManager_workspaceId_idx" ON "TeamManager"("workspaceId");
CREATE INDEX "TeamManager_teamId_idx" ON "TeamManager"("teamId");

ALTER TABLE "TeamManager"
  ADD CONSTRAINT "TeamManager_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeamManager"
  ADD CONSTRAINT "TeamManager_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TeamManager"
  ADD CONSTRAINT "TeamManager_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Team" DROP CONSTRAINT IF EXISTS "Team_managerId_fkey";
DROP INDEX IF EXISTS "Team_workspaceId_managerId_key";
DROP INDEX IF EXISTS "Team_managerId_idx";
ALTER TABLE "Team" DROP COLUMN IF EXISTS "managerId";
