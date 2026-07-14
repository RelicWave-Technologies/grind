-- One canonical workspace business timezone. All stored timestamps remain UTC
-- instants; this migration changes no tracked, screenshot, activity, or
-- manual-time history.
ALTER TABLE "Workspace"
  ADD COLUMN "timezone" TEXT NOT NULL DEFAULT 'UTC';

-- Choose only PostgreSQL-known IANA names. PostgreSQL also accepts some
-- abbreviations which Node/browser Intl may reject, so keep UTC or a
-- slash-style zone name only. `ws_default` is the established
-- production workspace and has a known Asia/Kolkata business calendar. For all
-- other workspaces, prefer explicit non-UTC settings, then valid legacy values,
-- and finally UTC. Invalid legacy values are never allowed to overwrite a
-- valid candidate.
WITH selected_timezone AS (
  SELECT
    workspace."id",
    CASE
      WHEN workspace."id" = 'ws_default' THEN 'Asia/Kolkata'
      ELSE COALESCE(
        tester_non_utc."timezone",
        payroll_non_utc."timezone",
        tester_any."timezone",
        payroll_any."timezone",
        'UTC'
      )
    END AS "timezone"
  FROM "Workspace" AS workspace
  LEFT JOIN LATERAL (
    SELECT config."timezone"
    FROM "TesterOpsConfig" AS config
    JOIN pg_timezone_names AS zone ON zone.name = config."timezone"
    WHERE config."workspaceId" = workspace."id"
      AND (config."timezone" = 'UTC' OR config."timezone" LIKE '%/%')
      AND config."timezone" <> 'UTC'
    LIMIT 1
  ) AS tester_non_utc ON TRUE
  LEFT JOIN LATERAL (
    SELECT policy."timezone"
    FROM "PayrollPolicy" AS policy
    JOIN pg_timezone_names AS zone ON zone.name = policy."timezone"
    WHERE policy."workspaceId" = workspace."id"
      AND (policy."timezone" = 'UTC' OR policy."timezone" LIKE '%/%')
      AND policy."timezone" <> 'UTC'
    LIMIT 1
  ) AS payroll_non_utc ON TRUE
  LEFT JOIN LATERAL (
    SELECT config."timezone"
    FROM "TesterOpsConfig" AS config
    JOIN pg_timezone_names AS zone ON zone.name = config."timezone"
    WHERE config."workspaceId" = workspace."id"
      AND (config."timezone" = 'UTC' OR config."timezone" LIKE '%/%')
    LIMIT 1
  ) AS tester_any ON TRUE
  LEFT JOIN LATERAL (
    SELECT policy."timezone"
    FROM "PayrollPolicy" AS policy
    JOIN pg_timezone_names AS zone ON zone.name = policy."timezone"
    WHERE policy."workspaceId" = workspace."id"
      AND (policy."timezone" = 'UTC' OR policy."timezone" LIKE '%/%')
    LIMIT 1
  ) AS payroll_any ON TRUE
)
UPDATE "Workspace" AS workspace
SET "timezone" = selected_timezone."timezone"
FROM selected_timezone
WHERE selected_timezone."id" = workspace."id";

-- Legacy columns are compatibility mirrors, never independent authorities.
UPDATE "PayrollPolicy" AS policy
SET "timezone" = workspace."timezone"
FROM "Workspace" AS workspace
WHERE workspace."id" = policy."workspaceId"
  AND policy."timezone" IS DISTINCT FROM workspace."timezone";

UPDATE "TesterOpsConfig" AS config
SET "timezone" = workspace."timezone"
FROM "Workspace" AS workspace
WHERE workspace."id" = config."workspaceId"
  AND config."timezone" IS DISTINCT FROM workspace."timezone";
