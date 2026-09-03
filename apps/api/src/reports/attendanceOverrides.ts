import { prisma } from '@grind/db';
import type {
  AttendanceOverrideCode,
  AttendanceOverrideHistoryEntry,
  DayStatus,
} from '@grind/types';
import { loadWorkingCalendar } from '../leave';
import { overrideDayCost, reconcileOverrideLedger } from '../leave/overrideLedger';
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
  /**
   * How much of a day's leave the balance covered, from the calendar that
   * already worked it out. A correction states the shape of a day; this is what
   * turns that shape into paid or unpaid, and a caller without it gets the
   * answer for somebody whose balance always reached.
   */
  fundedDaysFor?: (userId: string, date: string) => number | undefined;
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
    const date = r.date.toISOString().slice(0, 10);
    index.set(`${r.userId}|${date}`, {
      code: r.code,
      computedCode: r.computedCode,
      fundedDays: input.fundedDaysFor?.(r.userId, date),
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
  tz: string;
  code: AttendanceOverrideCode;
  reason: string;
  setById: string;
  computedCode: string;
}): Promise<void> {
  const date = new Date(`${input.date}T00:00:00Z`);
  // What the leave data bills for this day on its own, so the entry below can
  // record the difference the correction makes rather than a second full charge
  // on top of Lark's.
  const calendar = await loadWorkingCalendar({
    workspaceId: input.workspaceId,
    tz: input.tz,
    userIds: [input.userId],
    from: input.date,
    to: input.date,
  });
  await reconcileOverrideLedger({
    workspaceId: input.workspaceId,
    userId: input.userId,
    date: input.date,
    alreadyCharged: calendar.leaveChargeFor(input.userId, input.date),
    nowCosts: overrideDayCost(input.code, calendar.isChargeableDay(input.userId, input.date)),
    createdById: input.setById,
  });
  await prisma.$transaction([
    prisma.attendanceOverrideEvent.create({
      data: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        date,
        code: input.code,
        reason: input.reason,
        computedCode: input.computedCode,
        setById: input.setById,
      },
    }),
    prisma.attendanceOverride.upsert({
      where: { userId_date: { userId: input.userId, date } },
      // Re-setting a day replaces the decision in force rather than stacking a
      // second one nobody could order, and re-snapshots what the report says
      // right now. The one it replaces survives in the log.
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
    }),
  ]);
}

/**
 * Every decision ever made about this person-day, newest first.
 *
 * Read from the log rather than from the row in force, because the row only
 * remembers the last person to touch it. The question three months later is
 * never "what does it say" but "who decided that, and what did they know".
 */
export async function loadOverrideHistory(input: {
  userId: string;
  date: string;
}): Promise<AttendanceOverrideHistoryEntry[]> {
  const rows = await prisma.attendanceOverrideEvent.findMany({
    where: { userId: input.userId, date: new Date(`${input.date}T00:00:00Z`) },
    orderBy: { setAt: 'desc' },
    select: {
      code: true,
      reason: true,
      computedCode: true,
      setAt: true,
      setBy: { select: { name: true } },
    },
  });
  return rows.map((r) => ({
    code: r.code,
    reason: r.reason,
    computedCode: r.computedCode,
    setAt: r.setAt.toISOString(),
    setByName: r.setBy?.name ?? null,
  }));
}

/**
 * Remove a correction, returning the day to whatever the report computes.
 *
 * Logged with a null code, because taking a correction back is itself a
 * decision somebody made and will be asked about. Deleting the row and leaving
 * no trace would make the day look like one nobody had ever questioned.
 */
export async function clearAttendanceOverride(input: {
  workspaceId: string;
  userId: string;
  date: string;
  reason: string;
  setById: string;
  computedCode: string | null;
}): Promise<boolean> {
  const date = new Date(`${input.date}T00:00:00Z`);
  const existing = await prisma.attendanceOverride.findUnique({
    where: { userId_date: { userId: input.userId, date } },
    select: { id: true },
  });
  if (!existing) return false;
  // The leave data goes back to billing the day by itself, so the reconciling
  // entry has to go rather than sit there charging it a second time.
  await reconcileOverrideLedger({
    workspaceId: input.workspaceId,
    userId: input.userId,
    date: input.date,
    alreadyCharged: 0,
    nowCosts: null,
    createdById: input.setById,
  });
  await prisma.$transaction([
    prisma.attendanceOverrideEvent.create({
      data: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        date,
        code: null,
        reason: input.reason,
        computedCode: input.computedCode,
        setById: input.setById,
      },
    }),
    prisma.attendanceOverride.delete({ where: { id: existing.id } }),
  ]);
  return true;
}
