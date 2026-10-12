import { prisma } from '@grind/db';
import { localDayWindowInTimeZone } from '@grind/types';

/**
 * Activity samples per person per workspace date, counted in Postgres.
 *
 * The timesheet's "samples" column used to read every sample of the range
 * (userId + bucketStart, ~480 a person a day — over half a million rows for a
 * 14-day team view) only to add one per row in JS. This asks the database for
 * the counts instead, with the same rules:
 *
 *  - a sample belongs to the workspace date whose local-day window
 *    [start, end) holds its bucketStart — the windows are computed here in JS
 *    (localDayWindowInTimeZone, DST-exact) and handed to SQL as bounds, so
 *    Postgres never has to know the timezone rules;
 *  - a sample inside a reviewer invalidation (windowStart <= t < windowEnd) is
 *    not counted, as `invalidatedAt` decides it.
 *
 * Stored times are UTC `timestamp`s (no zone), so the bounds are passed as
 * UTC wall clocks.
 */
export async function countActivitySamplesByDay(input: {
  userIds: readonly string[];
  days: readonly string[];
  tz: string;
}): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  const windows = input.days.flatMap((day) => {
    const win = localDayWindowInTimeZone(day, input.tz);
    return win ? [{ day, start: utcTimestamp(win.start), end: utcTimestamp(win.end) }] : [];
  });
  if (input.userIds.length === 0 || windows.length === 0) return out;

  // One small (userId, bucketStart) index range scan per day (LATERAL), which
  // keeps the plan from turning into a join filter over every sample.
  const rows = await prisma.$queryRaw<Array<{ userId: string; day: string; n: number }>>`
    SELECT c."userId" AS "userId", w.day AS day, c.n AS n
    FROM unnest(
      ${windows.map((w) => w.day)}::text[],
      ${windows.map((w) => w.start)}::timestamp[],
      ${windows.map((w) => w.end)}::timestamp[]
    ) AS w(day, ws, we)
    CROSS JOIN LATERAL (
      SELECT s."userId", count(*)::int AS n
      FROM "ActivitySample" s
      WHERE s."userId" = ANY(${[...new Set(input.userIds)]}::text[])
        AND s."bucketStart" >= w.ws
        AND s."bucketStart" < w.we
        AND NOT EXISTS (
          SELECT 1 FROM "TimeInvalidation" i
          WHERE i."userId" = s."userId"
            AND i."windowStart" <= s."bucketStart"
            AND i."windowEnd" > s."bucketStart"
        )
      GROUP BY s."userId"
    ) c
  `;
  for (const row of rows) {
    let perUser = out.get(row.userId);
    if (!perUser) {
      perUser = new Map();
      out.set(row.userId, perUser);
    }
    perUser.set(row.day, row.n);
  }
  return out;
}

/** An instant as the UTC wall clock a `timestamp` column stores ('2026-10-12 03:45:00.000'). */
function utcTimestamp(d: Date): string {
  return d.toISOString().replace('T', ' ').replace('Z', '');
}
