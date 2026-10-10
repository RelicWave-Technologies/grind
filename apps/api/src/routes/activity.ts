import { Router } from 'express';
import { prisma } from '@grind/db';
import {
  ActivitySamplesRequest,
  type ActivitySamplesResponse,
  applyPolicyToActive,
  WORKSPACE_POLICY_DEFAULTS,
  type PolicyFlags,
} from '@grind/types';
import { validate } from '../middleware/validate';
import { requireAccessToken } from '../middleware/auth';
import { persistFlagsForUser } from '../anticheat/persistFlags';
import { logger } from '../logger';
import { classifyEntryClaims, linkClaimsIfEntriesArrived } from '../timeEntries/claimedEvidence';

export const activityRouter = Router();

activityRouter.use(requireAccessToken);

interface IngestRow {
  id: string;
  timeEntryId: string | null;
  /** The entry the agent named before the server had it (see claimedEvidence). */
  claimedTimeEntryId: string | null;
  bucketStart: Date;
  keystrokes: number;
  clicks: number;
  mouseDistancePx: number;
  scrollEvents: number;
  ikiCv: number | null;
  moveSpeedCv: number | null;
  pathStraightness: number | null;
  activeApp: string | null;
  activeAppBundle: string | null;
  activeTitle: string | null;
  activeUrl: string | null;
}

/**
 * Two reports of one minute → the minute. Counts keep the larger value, so a
 * re-sent total is idempotent and a partial can never overwrite the fuller
 * report of its minute (an agent restarted mid-minute used to send its tail,
 * which replaced the head the server already had). Timing CVs follow the
 * report with more of the input they were measured on.
 */
function mergeMinuteReports(a: IngestRow, b: IngestRow): IngestRow {
  const keysFromB = b.keystrokes >= a.keystrokes;
  const movesFromB = b.mouseDistancePx >= a.mouseDistancePx;
  const timeEntryId = b.timeEntryId ?? a.timeEntryId;
  return {
    id: a.id,
    timeEntryId,
    // A claim only waits for an entry; once the minute is attached it is done.
    claimedTimeEntryId: timeEntryId ? null : b.claimedTimeEntryId ?? a.claimedTimeEntryId,
    bucketStart: a.bucketStart,
    keystrokes: Math.max(a.keystrokes, b.keystrokes),
    clicks: Math.max(a.clicks, b.clicks),
    mouseDistancePx: Math.max(a.mouseDistancePx, b.mouseDistancePx),
    scrollEvents: Math.max(a.scrollEvents, b.scrollEvents),
    ikiCv: keysFromB ? b.ikiCv ?? a.ikiCv : a.ikiCv ?? b.ikiCv,
    moveSpeedCv: movesFromB ? b.moveSpeedCv ?? a.moveSpeedCv : a.moveSpeedCv ?? b.moveSpeedCv,
    pathStraightness: movesFromB ? b.pathStraightness ?? a.pathStraightness : a.pathStraightness ?? b.pathStraightness,
    activeApp: b.activeApp ?? a.activeApp,
    activeAppBundle: b.activeAppBundle ?? a.activeAppBundle,
    activeTitle: b.activeTitle ?? a.activeTitle,
    activeUrl: b.activeUrl ?? a.activeUrl,
  };
}

const INGEST_COLUMNS = 16;

/**
 * Insert-or-merge a batch in one statement. The merge is the SQL twin of
 * {@link mergeMinuteReports} and runs atomically per row, so two requests
 * carrying the same minute cannot lose either one's counts.
 */
async function upsertMinutes(userId: string, rows: IngestRow[], policy: PolicyFlags): Promise<void> {
  if (rows.length === 0) return;
  const params: unknown[] = [];
  const tuples = rows.map((r, i) => {
    const o = i * INGEST_COLUMNS;
    params.push(
      r.id, userId, r.timeEntryId, r.bucketStart.toISOString(),
      r.keystrokes, r.clicks, r.mouseDistancePx, r.scrollEvents,
      r.ikiCv, r.moveSpeedCv, r.pathStraightness,
      r.activeApp, r.activeAppBundle, r.activeTitle, r.activeUrl,
      r.claimedTimeEntryId,
    );
    return `($${o + 1}::text, $${o + 2}::text, $${o + 3}::text, ($${o + 4}::timestamptz AT TIME ZONE 'UTC'),
      $${o + 5}::int, $${o + 6}::int, $${o + 7}::int, $${o + 8}::int,
      $${o + 9}::double precision, $${o + 10}::double precision, $${o + 11}::double precision,
      $${o + 12}::text, $${o + 13}::text, $${o + 14}::text, $${o + 15}::text,
      $${o + 16}::text)`;
  });
  const cur = '"ActivitySample"';
  // A field the policy does not capture is cleared, not kept from an earlier
  // report: what is stored must match the policy in force when it is written.
  const keep = (column: string, allowed: boolean) =>
    allowed ? `COALESCE(EXCLUDED."${column}", ${cur}."${column}")` : 'NULL';
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ActivitySample" ("id", "userId", "timeEntryId", "bucketStart",
       "keystrokes", "clicks", "mouseDistancePx", "scrollEvents",
       "ikiCv", "moveSpeedCv", "pathStraightness",
       "activeApp", "activeAppBundle", "activeTitle", "activeUrl",
       "claimedTimeEntryId")
     VALUES ${tuples.join(',\n')}
     ON CONFLICT ("userId", "bucketStart") DO UPDATE SET
       "timeEntryId" = COALESCE(EXCLUDED."timeEntryId", ${cur}."timeEntryId"),
       "claimedTimeEntryId" = CASE WHEN COALESCE(EXCLUDED."timeEntryId", ${cur}."timeEntryId") IS NOT NULL
         THEN NULL ELSE COALESCE(EXCLUDED."claimedTimeEntryId", ${cur}."claimedTimeEntryId") END,
       "keystrokes" = GREATEST(${cur}."keystrokes", EXCLUDED."keystrokes"),
       "clicks" = GREATEST(${cur}."clicks", EXCLUDED."clicks"),
       "mouseDistancePx" = GREATEST(${cur}."mouseDistancePx", EXCLUDED."mouseDistancePx"),
       "scrollEvents" = GREATEST(${cur}."scrollEvents", EXCLUDED."scrollEvents"),
       "ikiCv" = CASE WHEN EXCLUDED."keystrokes" >= ${cur}."keystrokes"
         THEN COALESCE(EXCLUDED."ikiCv", ${cur}."ikiCv") ELSE COALESCE(${cur}."ikiCv", EXCLUDED."ikiCv") END,
       "moveSpeedCv" = CASE WHEN EXCLUDED."mouseDistancePx" >= ${cur}."mouseDistancePx"
         THEN COALESCE(EXCLUDED."moveSpeedCv", ${cur}."moveSpeedCv") ELSE COALESCE(${cur}."moveSpeedCv", EXCLUDED."moveSpeedCv") END,
       "pathStraightness" = CASE WHEN EXCLUDED."mouseDistancePx" >= ${cur}."mouseDistancePx"
         THEN COALESCE(EXCLUDED."pathStraightness", ${cur}."pathStraightness")
         ELSE COALESCE(${cur}."pathStraightness", EXCLUDED."pathStraightness") END,
       "activeApp" = ${keep('activeApp', policy.captureApps)},
       "activeAppBundle" = ${keep('activeAppBundle', policy.captureApps)},
       "activeTitle" = ${keep('activeTitle', policy.captureApps && policy.captureTitles)},
       "activeUrl" = ${keep('activeUrl', policy.captureApps && policy.captureUrls)}`,
    ...params,
  );
}

/**
 * Batch-ingest per-minute activity samples. Idempotent on (userId, bucketStart):
 * a minute reported again is MERGED (larger counts win), so agent retries never
 * duplicate and a late partial never erases what the minute already had.
 * Samples are content-free counts + timing CVs.
 */
activityRouter.post('/', validate(ActivitySamplesRequest, 'body'), async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const { samples } = req.body as ActivitySamplesRequest;
    const userId = req.user.sub;

    // Resolve the caller's workspace policy ONCE per request — defaults
    // when none exists. We pass the flags through `applyPolicyToActive`
    // for every sample so a misbehaving / outdated agent can never
    // smuggle in disabled active-window fields.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { workspaceId: true },
    });
    const policyRow = user
      ? await prisma.workspacePolicy.findUnique({ where: { workspaceId: user.workspaceId } })
      : null;
    const policy = policyRow ?? WORKSPACE_POLICY_DEFAULTS;

    // A timer entry is a parent of activity, but an agent whose entry create
    // is stuck in its sync queue uploads the minutes first. The batch is never
    // refused for that: a minute naming an entry we do not have yet is stored
    // detached with the claim, and linked when the entry arrives; a minute
    // naming somebody else's entry is stored detached, without the claim.
    const claims = await classifyEntryClaims(
      userId,
      samples.flatMap((sample) => (sample.timeEntryId ? [sample.timeEntryId] : [])),
    );
    let detached = 0;

    // One row per minute: a batch may carry the same minute twice (older
    // agents stored a minute once per seal), and one statement cannot touch
    // a row twice.
    const byMinute = new Map<number, IngestRow>();
    for (const s of samples) {
      const claim = s.timeEntryId ? claims.get(s.timeEntryId) : undefined;
      if (claim && claim.kind !== 'owned') detached += 1;
      const scrubbed = applyPolicyToActive(
        {
          activeApp: s.activeApp ?? null,
          activeAppBundle: s.activeAppBundle ?? null,
          activeTitle: s.activeTitle ?? null,
          activeUrl: s.activeUrl ?? null,
        },
        policy,
      );
      const bucketStart = new Date(s.bucketStart);
      const row: IngestRow = {
        id: s.id,
        timeEntryId: claim?.kind === 'owned' ? claim.timeEntryId : null,
        claimedTimeEntryId: claim?.kind === 'claimed' ? claim.claimedTimeEntryId : null,
        bucketStart,
        keystrokes: s.keystrokes,
        clicks: s.clicks,
        mouseDistancePx: s.mouseDistancePx,
        scrollEvents: s.scrollEvents,
        ikiCv: s.ikiCv ?? null,
        moveSpeedCv: s.moveSpeedCv ?? null,
        pathStraightness: s.pathStraightness ?? null,
        activeApp: scrubbed.activeApp ?? null,
        activeAppBundle: scrubbed.activeAppBundle ?? null,
        activeTitle: scrubbed.activeTitle ?? null,
        activeUrl: scrubbed.activeUrl ?? null,
      };
      const key = bucketStart.getTime();
      const seen = byMinute.get(key);
      byMinute.set(key, seen ? mergeMinuteReports(seen, row) : row);
    }
    await upsertMinutes(userId, [...byMinute.values()], policy);
    await linkClaimsIfEntriesArrived(
      userId,
      [...claims.values()].flatMap((claim) => (claim.kind === 'claimed' ? [claim.claimedTimeEntryId] : [])),
    );

    if (detached > 0) {
      logger.warn({ userId, detached, submitted: samples.length }, 'activity samples detached from unavailable timer entries');
    }
    const response: ActivitySamplesResponse = { accepted: samples.length, detached };
    res.status(201).json(response);

    // Anti-cheat scoring runs AFTER the response — it's a side effect for
    // the manager's review queue, never on the agent's hot path. Failure
    // here gets logged but doesn't bubble up: a flag-write hiccup must not
    // make the agent think its samples were rejected.
    void (async () => {
      try {
        const result = await persistFlagsForUser({
          userId,
          samples: samples.map((s) => ({
            bucketStartMs: new Date(s.bucketStart).getTime(),
            keystrokes: s.keystrokes,
            clicks: s.clicks,
            scrollEvents: s.scrollEvents,
            mouseDistancePx: s.mouseDistancePx,
            ikiCv: s.ikiCv ?? null,
            moveSpeedCv: s.moveSpeedCv ?? null,
            pathStraightness: s.pathStraightness ?? null,
          })),
        });
        if (result.inserted > 0) {
          logger.info({ userId, flagsInserted: result.inserted, riskScore: result.riskScore }, 'anti-cheat flags raised');
        }
      } catch (err) {
        logger.warn({ err: String(err), userId }, 'persistFlagsForUser failed (non-fatal)');
      }
    })();
  } catch (err) {
    next(err);
  }
});
