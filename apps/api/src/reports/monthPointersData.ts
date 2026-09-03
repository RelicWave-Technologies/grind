import { prisma } from '@grind/db';
import { ShiftScheduleSchema, type ShiftSchedule } from '@grind/types';
import { loadMonthPerformanceReport, type ResolvedReportMonth } from './monthPerformanceData';
import { buildMonthPointers, type MonthPointers } from './monthPointers';

/**
 * Computing and storing month pointers.
 *
 * The pointers are derived from the month report, so this loads that report and
 * summarises it rather than reading attendance a second way. Two readings of
 * the same month that disagree is the failure worth designing against here.
 */

export interface MonthPointerRow {
  userId: string;
  name: string;
  email: string;
  teamName: string | null;
  shiftName: string | null;
  pointers: MonthPointers;
}

/**
 * A person's shift window and its grace buffer.
 *
 * Read from `User.shiftId` — the shift they are on now, not the one they were
 * on in the month being summarised. `ShiftAssignment` holds that history, and
 * using it would be more correct; it is deliberately left for when somebody
 * actually reassigns a shift mid-month, because the workspace runs one shift
 * for ninety-nine of its hundred and eleven people and the extra query would
 * buy nothing today.
 */
async function loadShiftsFor(userIds: readonly string[]): Promise<
  Map<string, { name: string; schedule: ShiftSchedule; bufferMin: number }>
> {
  const out = new Map<string, { name: string; schedule: ShiftSchedule; bufferMin: number }>();
  if (userIds.length === 0) return out;

  const users = await prisma.user.findMany({
    where: { id: { in: [...userIds] } },
    select: { id: true, shift: { select: { name: true, schedule: true, bufferMin: true } } },
  });

  for (const u of users) {
    if (!u.shift) continue;
    // A schedule that does not parse is treated as no shift rather than thrown
    // on: one malformed row should cost that person their arrival counts, not
    // cost everybody else the whole month's pointers.
    const parsed = ShiftScheduleSchema.safeParse(u.shift.schedule);
    if (!parsed.success) continue;
    out.set(u.id, { name: u.shift.name, schedule: parsed.data, bufferMin: u.shift.bufferMin });
  }
  return out;
}

/** Compute pointers for a month without writing anything. */
export async function computeMonthPointers(input: {
  workspaceId: string;
  userIds: string[];
  range: ResolvedReportMonth;
}): Promise<MonthPointerRow[]> {
  const [report, shifts] = await Promise.all([
    loadMonthPerformanceReport({
      workspaceId: input.workspaceId,
      userIds: input.userIds,
      range: input.range,
    }),
    loadShiftsFor(input.userIds),
  ]);

  return report.rows.map((row) => {
    const shift = shifts.get(row.user.id) ?? null;
    return {
      userId: row.user.id,
      name: row.user.name,
      email: row.user.email,
      teamName: row.user.teamName,
      shiftName: shift?.name ?? null,
      pointers: buildMonthPointers({
        days: row.days,
        schedule: shift?.schedule ?? null,
        bufferMin: shift?.bufferMin ?? 0,
      }),
    };
  });
}

/**
 * Compute a month's pointers and write them.
 *
 * Upserted on `(userId, month)`, so running it twice is a no-op and running it
 * after a correction lands overwrites the stale verdict. Every field is
 * derived, which is what makes overwriting safe: there is nothing here a
 * recompute could lose.
 */
export async function storeMonthPointers(input: {
  workspaceId: string;
  userIds: string[];
  range: ResolvedReportMonth;
}): Promise<{ month: string; written: number; rows: MonthPointerRow[] }> {
  const rows = await computeMonthPointers(input);
  const month = input.range.month;
  const computedAt = new Date();

  // Sequential rather than a transaction: a hundred small upserts inside one
  // transaction holds a write lock for the length of the whole recompute, and
  // there is nothing to roll back — a half-written recompute leaves correct
  // rows for the people it reached and stale ones for the rest, which is what a
  // failed run should leave.
  for (const row of rows) {
    const p = row.pointers;
    const data = {
      workedDays: p.workedDays,
      fullDays: p.fullDays,
      halfDays: p.halfDays,
      workMinutes: p.workMinutes,
      avgMinutes: p.averageMinutes,
      band: p.band,
      fullDaysUnderSix: p.fullDaysUnderSix,
      halfDaysUpToTwo: p.halfDaysUpToTwo,
      fullDaysNineOrMore: p.fullDaysNineOrMore,
      halfDaysOverFive: p.halfDaysOverFive,
      lateDays: p.lateDays,
      lateDaysAfterBuffer: p.lateDaysAfterBuffer,
      earlyDays: p.earlyDays,
      daysWithoutPunch: p.daysWithoutPunch,
      computedAt,
    };
    await prisma.monthPerformancePointer.upsert({
      where: { userId_month: { userId: row.userId, month } },
      create: { workspaceId: input.workspaceId, userId: row.userId, month, ...data },
      update: data,
    });
  }

  return { month, written: rows.length, rows };
}
