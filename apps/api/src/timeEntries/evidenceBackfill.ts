import { prisma } from '@grind/db';

/**
 * One-off repair for evidence orphaned before claims existed (see
 * `claimedEvidence.ts`): screenshots and activity minutes stored without their
 * time entry while the agent's entry create was stuck — or refused outright,
 * as `/screenshots/complete` did until m66.
 *
 * Three steps, each a single statement per table, dry-run by default:
 *  1. `claimed*`  — evidence whose claimed entry now exists for the same
 *                   person: linked to it (what entry create does today).
 *  2. `window*`   — evidence with no entry and no claim: linked to the
 *                   person's entry whose [startedAt, endedAt ?? now] holds it.
 *                   Held by two or more entries → left alone, counted as
 *                   ambiguous.
 *  3. `promote*`  — screenshots whose bytes the server itself stored in Drive
 *                   (direct-upload recorded the file) but which never reached
 *                   UPLOADED because /complete refused them. `/complete` would
 *                   promote them today; rows younger than an hour are skipped
 *                   so an upload in flight is left to finish.
 */

export interface EvidenceBackfillOptions {
  apply: boolean;
  /** Only this person. */
  userId?: string;
  /** Only evidence captured at or after this instant. */
  since?: Date;
  now?: Date;
}

export interface EvidenceBackfillReport {
  mode: 'dry-run' | 'applied';
  claimedScreenshots: number;
  claimedSamples: number;
  windowScreenshots: number;
  windowSamples: number;
  ambiguousScreenshots: number;
  ambiguousSamples: number;
  promoteScreenshots: number;
}

const IN_FLIGHT_MS = 60 * 60 * 1000;

// Every statement takes the same four parameters, so the SQL stays static:
//   $1 now, $2 since, $3 the in-flight cutoff (ISO strings, read as UTC into
//   the timestamp(3) columns whatever the session time zone), $4 the person or
//   NULL for everybody.
const NOW = `($1::timestamptz AT TIME ZONE 'UTC')`;
const SINCE = `($2::timestamptz AT TIME ZONE 'UTC')`;
const IN_FLIGHT_CUTOFF = `($3::timestamptz AT TIME ZONE 'UTC')`;
const forUser = (column: string) => `($4::text IS NULL OR ${column} = $4::text)`;

/** Step 1: the claimed entry exists for the same person (`s` / `a` joined to `e`). */
const CLAIMED_SCREENSHOT = `s."claimedTimeEntryId" = e."id" AND e."userId" = s."userId"
  AND s."capturedAt" >= ${SINCE} AND ${forUser('s."userId"')}`;
const CLAIMED_SAMPLE = `a."claimedTimeEntryId" = e."id" AND e."userId" = a."userId"
  AND a."bucketStart" >= ${SINCE} AND ${forUser('a."userId"')}`;

/** Step 2: evidence with no entry and no claim, against the entries holding it. */
const SCREENSHOT_MATCHES = `
  SELECT s."id", MIN(e."id") AS "entryId", COUNT(*)::int AS "matches"
  FROM "Screenshot" s
  JOIN "TimeEntry" e ON e."userId" = s."userId"
    AND e."startedAt" <= s."capturedAt"
    AND COALESCE(e."endedAt", ${NOW}) >= s."capturedAt"
  WHERE s."timeEntryId" IS NULL AND s."claimedTimeEntryId" IS NULL AND s."deletedAt" IS NULL
    AND s."capturedAt" >= ${SINCE} AND ${forUser('s."userId"')}
  GROUP BY s."id"`;
// A minute bucket starts on the minute, so an entry's first one may begin up to
// a minute before the entry does.
const SAMPLE_MATCHES = `
  SELECT a."id", MIN(e."id") AS "entryId", COUNT(*)::int AS "matches"
  FROM "ActivitySample" a
  JOIN "TimeEntry" e ON e."userId" = a."userId"
    AND date_trunc('minute', e."startedAt") <= a."bucketStart"
    AND COALESCE(e."endedAt", ${NOW}) >= a."bucketStart"
  WHERE a."timeEntryId" IS NULL AND a."claimedTimeEntryId" IS NULL
    AND a."bucketStart" >= ${SINCE} AND ${forUser('a."userId"')}
  GROUP BY a."id"`;

/** Step 3: bytes the server recorded itself, never promoted past PENDING/FAILED. */
const PROMOTABLE = `
  SELECT s."id" FROM "Screenshot" s
  WHERE s."uploadState" <> 'UPLOADED' AND s."deletedAt" IS NULL
    AND s."s3Key" IS NOT NULL AND s."fullUrl" LIKE '%/v1/screenshots/assets/' || s."s3Key"
    AND s."createdAt" < ${IN_FLIGHT_CUTOFF}
    AND s."capturedAt" >= ${SINCE} AND ${forUser('s."userId"')}`;

export async function backfillEvidenceLinks(options: EvidenceBackfillOptions): Promise<EvidenceBackfillReport> {
  const now = options.now ?? new Date();
  const params = [
    now.toISOString(),
    (options.since ?? new Date(0)).toISOString(),
    new Date(now.getTime() - IN_FLIGHT_MS).toISOString(),
    options.userId ?? null,
  ];

  if (!options.apply) {
    const [counts] = await prisma.$queryRawUnsafe<Array<Omit<EvidenceBackfillReport, 'mode'>>>(
      `SELECT
        (SELECT COUNT(*)::int FROM "Screenshot" s JOIN "TimeEntry" e ON ${CLAIMED_SCREENSHOT}) AS "claimedScreenshots",
        (SELECT COUNT(*)::int FROM "ActivitySample" a JOIN "TimeEntry" e ON ${CLAIMED_SAMPLE}) AS "claimedSamples",
        (SELECT COUNT(*)::int FROM (${SCREENSHOT_MATCHES}) m WHERE m."matches" = 1) AS "windowScreenshots",
        (SELECT COUNT(*)::int FROM (${SAMPLE_MATCHES}) m WHERE m."matches" = 1) AS "windowSamples",
        (SELECT COUNT(*)::int FROM (${SCREENSHOT_MATCHES}) m WHERE m."matches" > 1) AS "ambiguousScreenshots",
        (SELECT COUNT(*)::int FROM (${SAMPLE_MATCHES}) m WHERE m."matches" > 1) AS "ambiguousSamples",
        (SELECT COUNT(*)::int FROM (${PROMOTABLE}) p) AS "promoteScreenshots"`,
      ...params,
    );
    return { mode: 'dry-run', ...counts! };
  }

  return prisma.$transaction(async (tx) => {
    // Ambiguity is read before step 2 links anything, as the dry run reads it.
    const [ambiguous] = await tx.$queryRawUnsafe<Array<{ screenshots: number; samples: number }>>(
      `SELECT
        (SELECT COUNT(*)::int FROM (${SCREENSHOT_MATCHES}) m WHERE m."matches" > 1) AS "screenshots",
        (SELECT COUNT(*)::int FROM (${SAMPLE_MATCHES}) m WHERE m."matches" > 1) AS "samples"`,
      ...params,
    );
    const claimedScreenshots = await tx.$executeRawUnsafe(
      `UPDATE "Screenshot" s SET "timeEntryId" = e."id", "claimedTimeEntryId" = NULL, "updatedAt" = ${NOW}
       FROM "TimeEntry" e WHERE ${CLAIMED_SCREENSHOT}`,
      ...params,
    );
    const claimedSamples = await tx.$executeRawUnsafe(
      `UPDATE "ActivitySample" a SET "timeEntryId" = e."id", "claimedTimeEntryId" = NULL
       FROM "TimeEntry" e WHERE ${CLAIMED_SAMPLE}`,
      ...params,
    );
    const windowScreenshots = await tx.$executeRawUnsafe(
      `UPDATE "Screenshot" s SET "timeEntryId" = m."entryId", "updatedAt" = ${NOW}
       FROM (${SCREENSHOT_MATCHES}) m WHERE s."id" = m."id" AND m."matches" = 1`,
      ...params,
    );
    const windowSamples = await tx.$executeRawUnsafe(
      `UPDATE "ActivitySample" a SET "timeEntryId" = m."entryId"
       FROM (${SAMPLE_MATCHES}) m WHERE a."id" = m."id" AND m."matches" = 1`,
      ...params,
    );
    const promoteScreenshots = await tx.$executeRawUnsafe(
      `UPDATE "Screenshot" SET "uploadState" = 'UPLOADED', "updatedAt" = ${NOW}
       WHERE "id" IN (${PROMOTABLE})`,
      ...params,
    );
    return {
      mode: 'applied' as const,
      claimedScreenshots,
      claimedSamples,
      windowScreenshots,
      windowSamples,
      ambiguousScreenshots: ambiguous!.screenshots,
      ambiguousSamples: ambiguous!.samples,
      promoteScreenshots,
    };
  }, { timeout: 5 * 60_000 });
}
