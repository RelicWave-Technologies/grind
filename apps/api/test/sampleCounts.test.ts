import { describe, it, expect } from 'vitest';
import { prisma } from '@grind/db';
import { dateKeysBetween, localDayWindowInTimeZone } from '@grind/types';
import { invalidatedAt, loadInvalidations } from '../src/time';
import { countActivitySamplesByDay } from '../src/insights/sampleCounts';
import { seedUser } from './helpers';

/**
 * The SQL count must equal what the timesheet used to compute in JS from the
 * raw rows: first local-day window holding the sample, invalidated minutes
 * skipped. Checked across a DST change and on every boundary.
 */

/** The previous implementation, kept as the oracle. */
async function referenceCounts(userIds: string[], days: string[], tz: string) {
  const windows = days.flatMap((day) => {
    const win = localDayWindowInTimeZone(day, tz);
    return win ? [{ day, startMs: win.start.getTime(), endMs: win.end.getTime() }] : [];
  });
  const start = new Date(windows[0]!.startMs);
  const end = new Date(windows[windows.length - 1]!.endMs);
  const samples = await prisma.activitySample.findMany({
    where: { userId: { in: userIds }, bucketStart: { gte: start, lt: end } },
    select: { userId: true, bucketStart: true },
  });
  const invalidated = invalidatedAt(await loadInvalidations(userIds, new Date(start.getTime() - 86_400_000), end));
  const out = new Map<string, Map<string, number>>();
  for (const s of samples) {
    const t = s.bucketStart.getTime();
    if (invalidated(s.userId, t)) continue;
    for (const w of windows) {
      if (t < w.startMs || t >= w.endMs) continue;
      const perUser = out.get(s.userId) ?? new Map<string, number>();
      perUser.set(w.day, (perUser.get(w.day) ?? 0) + 1);
      out.set(s.userId, perUser);
      break;
    }
  }
  return out;
}

function asObject(m: Map<string, Map<string, number>>) {
  return Object.fromEntries([...m].map(([u, d]) => [u, Object.fromEntries([...d].sort())]));
}

describe('countActivitySamplesByDay', () => {
  it('matches the per-row count across a DST change, boundaries and invalidations', async () => {
    const tz = 'America/New_York';
    const a = await seedUser({ role: 'ADMIN' });
    const b = await seedUser();
    // 2026-11-01 is the fall-back day in New York (25 hours long).
    const days = dateKeysBetween('2026-10-31', '2026-11-02');
    const instants: number[] = [];
    for (const day of days) {
      const win = localDayWindowInTimeZone(day, tz)!;
      const s = win.start.getTime();
      const e = win.end.getTime();
      // First minute, last minute, the exact end (belongs to the next day), and some in between.
      instants.push(s, e - 60_000, e, s + 3 * 3_600_000, s + 24 * 3_600_000 - 60_000);
    }
    instants.push(Date.parse('2026-10-30T12:00:00Z'), Date.parse('2026-11-05T12:00:00Z')); // outside the range
    const unique = [...new Set(instants)].sort((x, y) => x - y);
    let n = 0;
    for (const userId of [a.userId, b.userId]) {
      for (const t of unique) {
        n += 1;
        await prisma.activitySample.create({
          data: {
            id: `sc_${n}`,
            userId,
            bucketStart: new Date(t),
            keystrokes: 1,
            clicks: 1,
            mouseDistancePx: 1,
            scrollEvents: 0,
          },
        });
      }
    }
    // Invalidate two hours of a's fall-back day, starting exactly on a sample
    // (inclusive) and ending exactly on one (exclusive).
    const fallBack = localDayWindowInTimeZone('2026-11-01', tz)!;
    const flag = await prisma.activityFlag.create({
      data: {
        userId: a.userId,
        type: 'JIGGLER',
        windowStart: new Date(fallBack.start.getTime() + 3 * 3_600_000),
        windowEnd: new Date(fallBack.start.getTime() + 5 * 3_600_000),
        evidence: {},
        riskScore: 1,
      },
    });
    await prisma.timeInvalidation.create({
      data: {
        workspaceId: a.workspaceId,
        flagId: flag.id,
        userId: a.userId,
        windowStart: new Date(fallBack.start.getTime() + 3 * 3_600_000),
        windowEnd: new Date(fallBack.start.getTime() + 24 * 3_600_000 - 60_000),
        reason: 'test',
      },
    });

    const userIds = [a.userId, b.userId];
    const got = await countActivitySamplesByDay({ userIds, days, tz });
    const want = await referenceCounts(userIds, days, tz);
    expect(asObject(got)).toEqual(asObject(want));
    // Sanity: the invalidation removed exactly one of a's samples on that day.
    expect(got.get(a.userId)!.get('2026-11-01')).toBe(want.get(b.userId)!.get('2026-11-01')! - 1);
  });

  it('returns nothing for no people', async () => {
    expect((await countActivitySamplesByDay({ userIds: [], days: ['2026-10-01'], tz: 'UTC' })).size).toBe(0);
  });
});
