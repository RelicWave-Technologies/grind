-- Configure the production Timo status schedule for the Early Testing group.
-- This is deployment config, not application branching logic: future changes can be
-- made from Tester Ops admin config without another code path.
INSERT INTO "TesterOpsConfig" (
  "id",
  "workspaceId",
  "enabled",
  "chatId",
  "timezone",
  "pingTimes",
  "passiveIssueDetectionEnabled",
  "createdAt",
  "updatedAt"
)
SELECT
  'tester_ops_config_' || w."id",
  w."id",
  TRUE,
  'oc_ff8bd417683bfcfb32f15b29e4ae54dd',
  'Asia/Kolkata',
  ARRAY['18:00']::TEXT[],
  FALSE,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Workspace" w
ON CONFLICT ("workspaceId") DO UPDATE
SET
  "enabled" = TRUE,
  "chatId" = EXCLUDED."chatId",
  "timezone" = EXCLUDED."timezone",
  "pingTimes" = EXCLUDED."pingTimes",
  "updatedAt" = CURRENT_TIMESTAMP;
