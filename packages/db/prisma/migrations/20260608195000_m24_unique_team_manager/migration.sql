-- A person can manage only one team per workspace. For legacy duplicate data,
-- keep the earliest managed team and clear the manager from later duplicates so
-- the invariant can be enforced without deleting teams or members.
WITH ranked_managed_teams AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "workspaceId", "managerId"
      ORDER BY "createdAt" ASC, "id" ASC
    ) AS rn
  FROM "Team"
  WHERE "managerId" IS NOT NULL
)
UPDATE "Team"
SET "managerId" = NULL
WHERE "id" IN (
  SELECT "id"
  FROM ranked_managed_teams
  WHERE rn > 1
);

CREATE UNIQUE INDEX "Team_workspaceId_managerId_key" ON "Team"("workspaceId", "managerId");
