import { prisma } from '@grind/db';
import { isValidTimeZone, dateKeyInTimeZone } from '@grind/types';
import { loadPunchLookup } from '../attendance/punches';
import { localDayWindow } from '../insights/day';
import { loadEntryLiveEvidence } from '../insights/liveEntryEvidence';
import { resolveEffectiveEntrySegmentEnds } from '../insights/openSegmentEvidence';
import { loadTimeInvalidationsForUsers } from '../insights/timeInvalidations';
import { buildTimesheetMatrix, type TimesheetSegmentInput } from '../insights/timesheets';
import { timesheetCalendarInputs } from '../leave';
import {
  buildMonthPerformance,
  type MonthPerformanceReport,
  type MonthPerformanceUser,
} from './monthPerformance';

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/u;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ResolvedReportMonth {
  /** YYYY-MM. */
  month: string;
  /** First and last date of the month, YYYY-MM-DD. */
  from: string;
  to: string;
  tz: string;
}

/**
 * Read the requested month off a query string, defaulting to the month it is
 * now in the workspace's own timezone.
 *
 * Local to this module rather than borrowed from payroll: this report no longer
 * has anything to do with payroll, and sharing a helper would be the thread by
 * which the dependency crept back.
 */
export function resolveReportMonth(
  query: Record<string, unknown>,
  workspaceTz: string,
): ResolvedReportMonth | { error: string } {
  if (!isValidTimeZone(workspaceTz)) return { error: 'invalid_tz' };

  let month: string;
  if (typeof query.month === 'string' && MONTH_RE.test(query.month)) {
    month = query.month;
  } else if (query.month == null) {
    month = dateKeyInTimeZone(new Date(), workspaceTz).slice(0, 7);
  } else {
    return { error: 'invalid_month' };
  }

  const [y, m] = month.split('-').map((n) => Number.parseInt(n, 10));
  if (!y || !m) return { error: 'invalid_month' };
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    month,
    from: `${month}-01`,
    to: `${month}-${String(lastDay).padStart(2, '0')}`,
    tz: workspaceTz,
  };
}

/**
 * Load the month performance grid.
 *
 * Three reads: the tracked time that decides whether a day was worked, the
 * Working Calendar that the Lark leave integration feeds, and the punch records
 * behind the Office In / Office Out rows.
 *
 * The timesheet matrix is built the same way every other surface builds it, so
 * the hours here cannot disagree with the hours on /attendance. What this does
 * NOT load is the payroll classifier: its monthly guarantee and carry allocator
 * would quietly rewrite days, and an attendance record has to stay literal.
 *
 * Scoped by `userIds` rather than by workspace, so a manager pulling this
 * export gets their team and nobody else.
 */
export async function loadMonthPerformanceReport(input: {
  workspaceId: string;
  userIds: string[];
  range: ResolvedReportMonth;
  nowMs?: number;
}): Promise<MonthPerformanceReport> {
  const { range } = input;

  const [workspace, users] = await Promise.all([
    prisma.workspace.findUnique({ where: { id: input.workspaceId }, select: { name: true } }),
    input.userIds.length === 0
      ? []
      : prisma.user.findMany({
          where: { id: { in: input.userIds }, workspaceId: input.workspaceId, deactivatedAt: null },
          select: { id: true, name: true, email: true, team: { select: { name: true } } },
          orderBy: [{ name: 'asc' }, { email: 'asc' }],
        }),
  ]);

  const reportUsers: MonthPerformanceUser[] = users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    teamName: u.team?.name ?? null,
  }));
  const userIds = reportUsers.map((u) => u.id);

  const firstDay = localDayWindow(range.from, range.tz);
  const lastDay = localDayWindow(range.to, range.tz);
  if (!firstDay || !lastDay) throw new Error('invalid_date_or_tz');
  // A calendar day of slack on both sides: an entry that crosses local midnight
  // belongs partly to a day inside the month, and a query bounded exactly at
  // the month's edges would drop it.
  const lookbackStart = new Date(firstDay.start.getTime() - DAY_MS);
  const lookbackEnd = new Date(lastDay.end.getTime() + DAY_MS);

  const [calendar, punchFor, entries, invalidations] = await Promise.all([
    timesheetCalendarInputs({
      workspaceId: input.workspaceId,
      tz: range.tz,
      userIds,
      from: range.from,
      to: range.to,
    }),
    loadPunchLookup({ userIds, from: range.from, to: range.to }),
    userIds.length === 0 ? [] : prisma.timeEntry.findMany({
      where: {
        userId: { in: userIds },
        startedAt: { lt: lookbackEnd },
        OR: [{ endedAt: null }, { endedAt: { gt: lookbackStart } }],
      },
      include: { segments: { select: { kind: true, startedAt: true, endedAt: true } } },
    }),
    userIds.length === 0 ? [] : loadTimeInvalidationsForUsers(userIds, lookbackStart, lookbackEnd),
  ]);

  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs);
  const evidenceByEntry = await loadEntryLiveEvidence(entries, now);
  const segments: TimesheetSegmentInput[] = [];
  for (const e of entries) {
    const effectiveEnds = resolveEffectiveEntrySegmentEnds({
      segments: e.segments,
      entryEndedAt: e.endedAt,
      now,
      evidence: evidenceByEntry.get(e.id),
      lifecycle: e,
    });
    for (const [index, seg] of e.segments.entries()) {
      segments.push({
        userId: e.userId,
        source: e.source as 'AUTO' | 'MANUAL',
        segmentKind: seg.kind as 'WORK' | 'MEETING' | 'IDLE_TRIMMED',
        startedAt: seg.startedAt.getTime(),
        endedAt: (effectiveEnds[index] ?? now).getTime(),
      });
    }
  }

  const matrix = buildTimesheetMatrix({
    from: range.from,
    to: range.to,
    tz: range.tz,
    segments,
    invalidations,
    dayStatusFor: calendar.dayStatusFor,
    userIds,
  });

  /** Work, meetings and approved manual time — what Timo counts as worked. */
  const trackedMinutesFor = (userId: string, date: string): number =>
    Math.round((matrix?.cells[userId]?.[date]?.totalMs ?? 0) / 60_000);

  return buildMonthPerformance({
    month: range.month,
    tz: range.tz,
    companyName: workspace?.name ?? '',
    users: reportUsers,
    dayStatusFor: calendar.dayStatusFor,
    trackedMinutesFor,
    punchFor,
    generatedAtMs: nowMs,
  });
}
