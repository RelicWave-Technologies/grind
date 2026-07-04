-- Enforce the v1 org invariant:
-- non-admin team managers belong to the same home team they manage.
UPDATE "User" AS u
SET
  "teamId" = tm."teamId",
  role = 'MANAGER',
  "managerId" = NULL
FROM "TeamManager" AS tm
WHERE tm."userId" = u.id
  AND u.role <> 'ADMIN';

-- Clean up stale derived manager roles after the TeamManager migration.
UPDATE "User" AS u
SET
  role = 'MEMBER',
  "managerId" = NULL
WHERE u.role = 'MANAGER'
  AND NOT EXISTS (
    SELECT 1
    FROM "TeamManager" AS tm
    WHERE tm."userId" = u.id
  );
