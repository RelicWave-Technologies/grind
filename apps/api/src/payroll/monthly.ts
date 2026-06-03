import type { TimesheetMatrix } from '../insights/timesheets';

/**
 * Monthly payroll worksheet roll-up (M15). Pure — no DB, no clock. The
 * route layer assembles a TimesheetMatrix over the month and pipes it
 * through `buildMonthlyPayroll` to produce a per-user worksheet row.
 *
 * Per the user's earlier deferred constraint ("discuss with them and
 * Vijay sir for the exact format"), this ships a sensible default we
 * can iterate on. The schema captures:
 *   - daysPresent — distinct days with any tracked time
 *   - workedHours  / meetingHours / manualHours — hours summed per kind
 *   - totalHours   — workedHours + meetingHours + manualHours
 *   - avgDayHours  — totalHours / daysPresent (only when daysPresent > 0)
 *
 * Hour totals are decimal hours (e.g. 8.25). The CSV serializer emits
 * the same numbers with two decimal places — finance teams typically
 * prefer that over "Xh Ym" strings.
 */

export interface PayrollUserMeta {
  id: string;
  name: string;
  email: string;
  role: string;
  teamId: string | null;
  teamName: string | null;
}

export interface PayrollRow {
  user: PayrollUserMeta;
  daysPresent: number;
  workedHours: number;
  meetingHours: number;
  manualHours: number;
  totalHours: number;
  avgDayHours: number;
}

export interface MonthlyPayrollInput {
  month: string; // YYYY-MM
  tz: string;
  matrix: TimesheetMatrix;
  users: PayrollUserMeta[];
}

export interface MonthlyPayroll {
  month: string;
  tz: string;
  generatedAtMs: number;
  rows: PayrollRow[];
  totals: {
    daysPresent: number;
    workedHours: number;
    meetingHours: number;
    manualHours: number;
    totalHours: number;
  };
}

const MS_PER_HOUR = 60 * 60 * 1000;

/** Round to 2dp without introducing the float fuzz that Number() leaves. */
function roundHours(ms: number): number {
  return Math.round((ms / MS_PER_HOUR) * 100) / 100;
}

export function buildMonthlyPayroll(input: MonthlyPayrollInput, nowMs: number): MonthlyPayroll {
  const rows: PayrollRow[] = [];
  let totalWorkedMs = 0;
  let totalMeetingMs = 0;
  let totalManualMs = 0;
  let totalDaysPresent = 0;

  for (const user of input.users) {
    const userCells = input.matrix.cells[user.id] ?? {};
    let workedMs = 0;
    let meetingMs = 0;
    let manualMs = 0;
    let daysPresent = 0;

    for (const day of input.matrix.days) {
      const c = userCells[day];
      if (!c) continue;
      if (c.totalMs > 0) daysPresent += 1;
      workedMs += c.workedMs;
      meetingMs += c.meetingMs;
      manualMs += c.manualMs;
    }

    const totalHours = roundHours(workedMs + meetingMs + manualMs);
    const workedHours = roundHours(workedMs);
    const meetingHours = roundHours(meetingMs);
    const manualHours = roundHours(manualMs);
    const avgDayHours = daysPresent === 0 ? 0 : Math.round((totalHours / daysPresent) * 100) / 100;

    rows.push({
      user,
      daysPresent,
      workedHours,
      meetingHours,
      manualHours,
      totalHours,
      avgDayHours,
    });

    totalWorkedMs += workedMs;
    totalMeetingMs += meetingMs;
    totalManualMs += manualMs;
    totalDaysPresent += daysPresent;
  }

  // Stable sort: total hours desc, then name asc.
  rows.sort((a, b) => {
    if (b.totalHours !== a.totalHours) return b.totalHours - a.totalHours;
    return a.user.name.localeCompare(b.user.name);
  });

  return {
    month: input.month,
    tz: input.tz,
    generatedAtMs: nowMs,
    rows,
    totals: {
      daysPresent: totalDaysPresent,
      workedHours: roundHours(totalWorkedMs),
      meetingHours: roundHours(totalMeetingMs),
      manualHours: roundHours(totalManualMs),
      totalHours: roundHours(totalWorkedMs + totalMeetingMs + totalManualMs),
    },
  };
}

/**
 * CSV serialization — header row + one row per user + a TOTALS line.
 * Tab-friendly column order; safe quoting for names containing commas
 * or quotes. RFC 4180-ish: doubled quotes for embedded quotes.
 */
export function formatPayrollCsv(p: MonthlyPayroll): string {
  const header = [
    'Month',
    'Name',
    'Email',
    'Role',
    'Team',
    'Days present',
    'Worked hours',
    'Meeting hours',
    'Manual hours',
    'Total hours',
    'Avg day hours',
  ].join(',');

  const lines = [header];
  for (const r of p.rows) {
    lines.push(
      [
        p.month,
        csv(r.user.name),
        csv(r.user.email),
        r.user.role,
        csv(r.user.teamName ?? ''),
        r.daysPresent,
        r.workedHours.toFixed(2),
        r.meetingHours.toFixed(2),
        r.manualHours.toFixed(2),
        r.totalHours.toFixed(2),
        r.avgDayHours.toFixed(2),
      ].join(','),
    );
  }
  lines.push(
    [
      p.month,
      'TOTAL',
      '',
      '',
      '',
      p.totals.daysPresent,
      p.totals.workedHours.toFixed(2),
      p.totals.meetingHours.toFixed(2),
      p.totals.manualHours.toFixed(2),
      p.totals.totalHours.toFixed(2),
      '',
    ].join(','),
  );
  return lines.join('\n');
}

function csv(v: string): string {
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}
