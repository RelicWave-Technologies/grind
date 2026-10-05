-- Timo answered some @mentions twice: the same Lark message arrives once over
-- the websocket (keyed by event_id) and again from the history poll (keyed by
-- message_id), and the only unique key was (workspaceId, source, sourceId).
-- One message must be one event, whichever path saw it first.

-- A worker claims an event (PENDING -> PROCESSING) before calling the AI, so a
-- second ingest of the same row cannot start a second reply.
ALTER TYPE "TesterOpsEventStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';

-- Existing duplicates would block the unique index. Nothing is deleted: the
-- earliest row per message keeps its messageId, and every later copy has the
-- column cleared (its issues, AI runs, sourceId and raw payload are untouched,
-- so the original id stays recoverable from sourceId/raw). NULLs are distinct
-- in a Postgres unique index, so the cleared rows no longer collide.
UPDATE "TesterOpsEvent" AS e
SET "messageId" = NULL
FROM (
  SELECT "id",
         ROW_NUMBER() OVER (
           PARTITION BY "workspaceId", "messageId"
           ORDER BY "createdAt" ASC, "id" ASC
         ) AS rn
  FROM "TesterOpsEvent"
  WHERE "messageId" IS NOT NULL
) AS d
WHERE e."id" = d."id"
  AND d.rn > 1;

CREATE UNIQUE INDEX "TesterOpsEvent_workspaceId_messageId_key" ON "TesterOpsEvent"("workspaceId", "messageId");
