import { prisma } from '@grind/db';
import type { AttendanceOverrideCode, DayStatus } from '@grind/types';
import { loadWorkingCalendar } from '../leave';
import { computedCodeForDay, type DayOverride } from './monthPerformance';

/**
 * A manager's or admin's correction to one day's attendance status.
 *
 * The report derives a status from the Working Calendar and Timo's tracked
 * time, and both can be wrong about a real day — an agent that stopped at 15:37
 * leaves an eight-hour day reading absent. Somebody who was there is the better
 * authority, so their answer wins.
 *
 * Two things are deliberate. The correction never touches the hours: the WORK
 * row keeps reporting what Timo tracked, so "the manager says present" and "the
 * machine recorded 5:37" remain two separate facts a reader can compare. And
 * the computed answer is snapshotted when the correction is written, so a day
 * whose ground later moves — leave arriving from Lark, time syncing late — can
 * be flagged instead of quietly disagreeing with the calendar.
 */

/** Corrections for a set of people over a range, as a lookup. */
export async function loadOverrideLookup(input: {
  userIds: string[];
  from: string;
  to: string;
}): Promise<(userId: string, date: string) => DayOverride | null> {
  if (input.userIds.length === 0) return () => null;
  const rows = await prisma.attendanceOverride.findMany({
    where: {
      userId: { in: input.userIds },
      date: { gte: new Date(`${input.from}T00:00:00Z`), lte: new Date(`${input.to}T00:00:00Z`) },
    },
    select: { userId: true, date: true, code: true, computedCode: true },
  });
  const index = new Map<string, DayOverride>();
  for (const r of rows) {
    // A DATE column reads back epoch-anchored; no timezone applies to it.
    index.set(`${r.userId}|${r.date.toISOString().slice(0, 10)}`, {
      code: r.code,
      computedCode: r.computedCode,
    });
  }
  return (userId, date) => index.get(`${userId}|${date}`) ?? null;
}

/** What the report would say for this person-day with nobody's correction. */
export async function computeDayCode(input: {
  workspaceId: string;
  userId: string;
  date: string;
  tz: string;
  trackedMinutes: number;
}): Promise<string> {
  const calendar = await loadWorkingCalendar({
    workspaceId: input.workspaceId,
    tz: input.tz,
    userIds: [input.userId],
    from: input.date,
    to: input.date,
  });
  const status: DayStatus | null = calendar.dayStatus(input.userId, input.date);
  return computedCodeForDay(status, input.trackedMinutes);
}

export async function setAttendanceOverride(input: {
  workspaceId: string;
  userId: string;
  date: string;
  code: AttendanceOverrideCode;
  reason: string;
  setById: string;
  computedCode: string;
}): Promise<void> {
  const date = new Date(`${input.date}T00:00:00Z`);
  await prisma.attendanceOverride.upsert({
    where: { userId_date: { userId: input.userId, date } },
    // Re-setting a day replaces the decision rather than stacking a second one
    // nobody could order, and re-snapshots what the report says right now.
    update: {
      code: input.code,
      reason: input.reason,
      setById: input.setById,
      setAt: new Date(),
      computedCode: input.computedCode,
    },
    create: {
      workspaceId: input.workspaceId,
      userId: input.userId,
      date,
      code: input.code,
      reason: input.reason,
      setById: input.setById,
      computedCode: input.computedCode,
    },
  });
}

/** Remove a correction, returning the day to whatever the report computes. */
export async function clearAttendanceOverride(input: {
  userId: string;
  date: string;
}): Promise<boolean> {
  const { count } = await prisma.attendanceOverride.deleteMany({
    where: { userId: input.userId, date: new Date(`${input.date}T00:00:00Z`) },
  });
  return count > 0;
}
