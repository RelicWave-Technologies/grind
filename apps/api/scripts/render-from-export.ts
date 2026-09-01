/**
 * Render the month performance report from a JSON data export rather than a
 * live database. Dev/ops tool — the production API is the real path; this
 * exists so a month can be rendered from an export while the endpoint is still
 * waiting to deploy.
 *
 *   tsx scripts/render-from-export.ts <export.json> <YYYY-MM> <outDir> [nameFilter]
 *
 * `nameFilter` is a comma-separated list of case-insensitive name fragments —
 * pass it to render a report for a handful of people rather than the whole
 * workspace.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { LeaveKind, LeavePortion } from '@grind/types';
import { WorkingCalendar, type ShiftAssignmentInput } from '../src/leave/workingCalendar';
import type { PunchLookup } from '../src/attendance/punches';
import { buildTimesheetMatrix, type TimesheetSegmentInput } from '../src/insights/timesheets';
import {
  buildMonthPerformance,
  formatMonthPerformanceCsv,
  monthDates,
  type MonthPerformanceUser,
} from '../src/reports/monthPerformance';
import { monthPerformanceXlsx } from '../src/reports/monthPerformanceXlsx';

const [, , exportPath, month, outDir, nameFilter] = process.argv;
const d = JSON.parse(readFileSync(exportPath!, 'utf8'));
const tz: string = d.workspace.timezone;

const day = (iso: string) => iso.slice(0, 10);
/** A TIME column arrives as an epoch date carrying a clock reading. */
const minuteOf = (iso: string | null) =>
  iso === null ? null : new Date(iso).getUTCHours() * 60 + new Date(iso).getUTCMinutes();

const shiftAssignments: Record<string, ShiftAssignmentInput[]> = {};
for (const a of d.assignments) {
  (shiftAssignments[a.userId] ??= []).push({
    shiftId: a.shiftId,
    effectiveFrom: new Date(a.effectiveFrom),
    effectiveTo: a.effectiveTo ? new Date(a.effectiveTo) : null,
    shiftNameSnapshot: a.shiftNameSnapshot,
    scheduleSnapshot: a.scheduleSnapshot,
  });
}

const userTeamIds: Record<string, string | null> = {};
const lastSaturdayOffFor: Record<string, boolean> = {};
for (const u of d.users) {
  userTeamIds[u.id] = u.teamId;
  lastSaturdayOffFor[u.id] = u.lastSaturdayOffOverride ?? d.lastSaturdayOff ?? false;
}

const calendar = new WorkingCalendar({
  tz,
  lastSaturdayOffFor,
  shiftAssignments,
  userTeamIds,
  holidays: d.holidays.map((h: { date: string; name: string; teamId: string | null }) => ({
    date: day(h.date), name: h.name, teamId: h.teamId,
  })),
  approvedLeave: d.leave.map((l: {
    userId: string; startDate: string; endDate: string; portion: LeavePortion; kind: LeaveKind;
  }) => ({
    userId: l.userId,
    startDate: day(l.startDate),
    endDate: day(l.endDate),
    portion: l.portion,
    kind: l.kind,
    label: l.kind === 'PAID' ? 'Paid leave' : 'Unpaid leave',
  })),
});

const punchIndex = new Map<string, { inMinute: number | null; outMinute: number | null }>();
for (const p of d.punches) {
  punchIndex.set(`${p.userId}|${day(p.date)}`, {
    inMinute: minuteOf(p.punchInAt),
    outMinute: minuteOf(p.punchOutAt),
  });
}
const punchFor: PunchLookup = (userId, date) => punchIndex.get(`${userId}|${date}`) ?? null;

/**
 * Tracked minutes per person-day, built with the same matrix the live loader
 * uses so an exported render and the endpoint cannot disagree about hours.
 */
const nowMs = Date.parse(`${month}-01T00:00:00Z`);
const segments: TimesheetSegmentInput[] = [];
for (const e of d.entries) {
  for (const seg of e.segments) {
    segments.push({
      userId: e.userId,
      source: e.source,
      segmentKind: seg.kind,
      startedAt: Date.parse(seg.startedAt),
      // An entry still open in the export has no end; the exporter ran after
      // the month closed, so clamp it there rather than inventing time.
      endedAt: seg.endedAt ? Date.parse(seg.endedAt) : Date.parse(e.endedAt ?? seg.startedAt),
    });
  }
}
const matrix = buildTimesheetMatrix({
  from: `${month}-01`,
  to: monthDates(month!)[monthDates(month!).length - 1]!,
  tz,
  segments,
  userIds: d.users.map((u: { id: string }) => u.id),
  dayStatusFor: (userId: string, date: string) => calendar.dayStatus(userId, date),
});
const trackedMinutesFor = (userId: string, date: string): number =>
  Math.round((matrix?.cells[userId]?.[date]?.totalMs ?? 0) / 60_000);

const wanted = nameFilter
  ? nameFilter.split(',').map((n) => n.trim().toLowerCase()).filter(Boolean)
  : null;

const users: MonthPerformanceUser[] = d.users
  .filter((u: { name: string }) =>
    !wanted || wanted.some((w) => u.name.toLowerCase().includes(w)))
  .map((u: { id: string; name: string; email: string; teamName: string | null }) => ({
    id: u.id, name: u.name, email: u.email, teamName: u.teamName,
  }))
  .sort((a: MonthPerformanceUser, b: MonthPerformanceUser) => a.name.localeCompare(b.name));

if (wanted && users.length === 0) {
  console.error(`no user matched: ${wanted.join(', ')}`);
  process.exit(1);
}

const report = buildMonthPerformance({
  month: month!,
  tz,
  companyName: d.workspace.name,
  users,
  dayStatusFor: (userId, date) => calendar.dayStatus(userId, date),
  trackedMinutesFor,
  punchFor,
  generatedAtMs: nowMs,
});

const slug = wanted ? `-${wanted.length}-people` : '';
const base = `${outDir}/prod-month-performance-${month}${slug}`;
writeFileSync(`${base}.csv`, formatMonthPerformanceCsv(report));

for (const r of report.rows) {
  const t = r.totals;
  const punched = r.days.filter((day) => day.punchInMinute !== null || day.punchOutMinute !== null).length;
  console.log(
    `${r.user.name.slice(0, 22).padEnd(24)}punched ${String(punched).padStart(2)}` +
    ` · P ${t.present} · HD ${t.halfDay} · WO ${t.weeklyOff} · HL ${t.holiday}` +
    ` · PL ${t.paidLeave} · LWP ${t.unpaidLeave} · A ${t.absent}` +
    ` · hours ${Math.floor(t.workMinutes / 60)}:${String(t.workMinutes % 60).padStart(2, '0')}`,
  );
}

monthPerformanceXlsx(report).then((buf) => {
  writeFileSync(`${base}.xlsx`, buf);
  console.log(`\nwrote ${base}.csv + .xlsx`);
});
