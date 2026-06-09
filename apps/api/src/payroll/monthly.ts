import type { TimesheetMatrix } from '../insights/timesheets';
import {
  PAYROLL_POLICY_DEFAULTS,
  ShiftScheduleSchema,
  WEEKDAYS,
  type ShiftSchedule,
} from '@grind/types';
import { localDayWindow } from '../insights/day';

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

export interface PayrollPolicyInput {
  halfDayLowerMin: number;
  halfDayUpperMin: number;
  fullDayLowerMin: number;
  fullDayUpperMin: number;
  monthlyLowerMin: number;
}

export interface PayrollShiftAssignmentInput {
  shiftId: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  shiftNameSnapshot: string | null;
  scheduleSnapshot: unknown;
}

export type PayrollDayStatus = 'FULL' | 'HALF' | 'OFF' | 'SCHEDULED_OFF' | 'NO_SHIFT';
export type PayrollDayReason =
  | 'monthly_total_met'
  | 'direct_full'
  | 'direct_half'
  | 'below_half'
  | 'carried_to_full'
  | 'carried_to_half'
  | 'scheduled_off'
  | 'no_shift';

export interface PayrollCarryLedger {
  fromDate: string;
  toDate: string;
  ms: number;
  reason: 'upgrade_to_full' | 'upgrade_to_half';
}

export interface PayrollDayClassification {
  date: string;
  rawMs: number;
  cappedMs: number;
  ignoredOverflowMs: number;
  eligible: boolean;
  shiftName: string | null;
  status: PayrollDayStatus;
  directStatus: PayrollDayStatus;
  reason: PayrollDayReason;
  carryInMs: number;
  carryOutMs: number;
}

export interface PayrollRow {
  user: PayrollUserMeta;
  daysPresent: number;
  workedHours: number;
  meetingHours: number;
  manualHours: number;
  totalHours: number;
  avgDayHours: number;
  rawHours: number;
  cappedHours: number;
  ignoredOverflowHours: number;
  eligibleDays: number;
  fullDays: number;
  halfDays: number;
  offDays: number;
  scheduledOffDays: number;
  noShiftDays: number;
  payableUnits: number;
  monthlyGuarantee: boolean;
  payrollDays: PayrollDayClassification[];
  carryLedger: PayrollCarryLedger[];
}

export interface MonthlyPayrollInput {
  month: string; // YYYY-MM
  tz: string;
  matrix: TimesheetMatrix;
  users: PayrollUserMeta[];
  policy?: PayrollPolicyInput;
  shiftAssignments?: Record<string, PayrollShiftAssignmentInput[]>;
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
    rawHours: number;
    cappedHours: number;
    ignoredOverflowHours: number;
    eligibleDays: number;
    fullDays: number;
    halfDays: number;
    offDays: number;
    payableUnits: number;
  };
}

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_MIN = 60 * 1000;

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
  let totalRawMs = 0;
  let totalCappedMs = 0;
  let totalIgnoredOverflowMs = 0;
  let totalEligibleDays = 0;
  let totalFullDays = 0;
  let totalHalfDays = 0;
  let totalOffDays = 0;
  let totalPayableUnits = 0;
  const policy = normalizePolicy(input.policy);

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

    const payroll = classifyUserMonth({
      userId: user.id,
      days: input.matrix.days,
      tz: input.tz,
      userCells,
      policy,
      shiftAssignments: input.shiftAssignments?.[user.id] ?? [],
    });

    rows.push({
      user,
      daysPresent,
      workedHours,
      meetingHours,
      manualHours,
      totalHours,
      avgDayHours,
      rawHours: roundHours(payroll.rawMs),
      cappedHours: roundHours(payroll.cappedMs),
      ignoredOverflowHours: roundHours(payroll.ignoredOverflowMs),
      eligibleDays: payroll.eligibleDays,
      fullDays: payroll.fullDays,
      halfDays: payroll.halfDays,
      offDays: payroll.offDays,
      scheduledOffDays: payroll.scheduledOffDays,
      noShiftDays: payroll.noShiftDays,
      payableUnits: payroll.payableUnits,
      monthlyGuarantee: payroll.monthlyGuarantee,
      payrollDays: payroll.days,
      carryLedger: payroll.carryLedger,
    });

    totalWorkedMs += workedMs;
    totalMeetingMs += meetingMs;
    totalManualMs += manualMs;
    totalDaysPresent += daysPresent;
    totalRawMs += payroll.rawMs;
    totalCappedMs += payroll.cappedMs;
    totalIgnoredOverflowMs += payroll.ignoredOverflowMs;
    totalEligibleDays += payroll.eligibleDays;
    totalFullDays += payroll.fullDays;
    totalHalfDays += payroll.halfDays;
    totalOffDays += payroll.offDays;
    totalPayableUnits += payroll.payableUnits;
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
      rawHours: roundHours(totalRawMs),
      cappedHours: roundHours(totalCappedMs),
      ignoredOverflowHours: roundHours(totalIgnoredOverflowMs),
      eligibleDays: totalEligibleDays,
      fullDays: totalFullDays,
      halfDays: totalHalfDays,
      offDays: totalOffDays,
      payableUnits: Math.round(totalPayableUnits * 100) / 100,
    },
  };
}

function normalizePolicy(policy: PayrollPolicyInput | undefined): Required<PayrollPolicyInput> {
  return {
    halfDayLowerMin: policy?.halfDayLowerMin ?? PAYROLL_POLICY_DEFAULTS.halfDayLowerMin,
    halfDayUpperMin: policy?.halfDayUpperMin ?? PAYROLL_POLICY_DEFAULTS.halfDayUpperMin,
    fullDayLowerMin: policy?.fullDayLowerMin ?? PAYROLL_POLICY_DEFAULTS.fullDayLowerMin,
    fullDayUpperMin: policy?.fullDayUpperMin ?? PAYROLL_POLICY_DEFAULTS.fullDayUpperMin,
    monthlyLowerMin: policy?.monthlyLowerMin ?? PAYROLL_POLICY_DEFAULTS.monthlyLowerMin,
  };
}

function classifyUserMonth(input: {
  userId: string;
  days: string[];
  tz: string;
  userCells: TimesheetMatrix['cells'][string];
  policy: Required<PayrollPolicyInput>;
  shiftAssignments: PayrollShiftAssignmentInput[];
}): {
  days: PayrollDayClassification[];
  carryLedger: PayrollCarryLedger[];
  rawMs: number;
  cappedMs: number;
  ignoredOverflowMs: number;
  eligibleDays: number;
  fullDays: number;
  halfDays: number;
  offDays: number;
  scheduledOffDays: number;
  noShiftDays: number;
  payableUnits: number;
  monthlyGuarantee: boolean;
} {
  const fullUpperMs = input.policy.fullDayUpperMin * MS_PER_MIN;
  const fullLowerMs = input.policy.fullDayLowerMin * MS_PER_MIN;
  const halfLowerMs = input.policy.halfDayLowerMin * MS_PER_MIN;
  const days: PayrollDayClassification[] = [];

  for (const date of input.days) {
    const cell = input.userCells[date];
    const rawMs = cell ? cell.workedMs + cell.meetingMs + cell.manualMs : 0;
    const cappedMs = Math.min(rawMs, fullUpperMs);
    const ignoredOverflowMs = Math.max(0, rawMs - fullUpperMs);
    const shift = resolvePayrollShiftForDay(date, input.tz, input.shiftAssignments);

    if (shift.kind === 'no_shift') {
      days.push({
        date,
        rawMs,
        cappedMs,
        ignoredOverflowMs,
        eligible: false,
        shiftName: null,
        status: 'NO_SHIFT',
        directStatus: 'NO_SHIFT',
        reason: 'no_shift',
        carryInMs: 0,
        carryOutMs: 0,
      });
      continue;
    }
    if (shift.kind === 'scheduled_off') {
      days.push({
        date,
        rawMs,
        cappedMs,
        ignoredOverflowMs,
        eligible: false,
        shiftName: shift.shiftName,
        status: 'SCHEDULED_OFF',
        directStatus: 'SCHEDULED_OFF',
        reason: 'scheduled_off',
        carryInMs: 0,
        carryOutMs: 0,
      });
      continue;
    }

    days.push({
      date,
      rawMs,
      cappedMs,
      ignoredOverflowMs,
      eligible: true,
      shiftName: shift.shiftName,
      status: 'OFF',
      directStatus: 'OFF',
      reason: 'below_half',
      carryInMs: 0,
      carryOutMs: 0,
    });
  }

  const eligible = days.filter((d) => d.eligible);
  const rawMs = days.reduce((sum, d) => sum + d.rawMs, 0);
  const cappedMs = eligible.reduce((sum, d) => sum + d.cappedMs, 0);
  const ignoredOverflowMs = days.reduce((sum, d) => sum + d.ignoredOverflowMs, 0);
  const monthlyGuarantee = cappedMs >= input.policy.monthlyLowerMin * MS_PER_MIN;
  const carryLedger: PayrollCarryLedger[] = [];

  if (monthlyGuarantee) {
    for (const d of eligible) {
      d.status = 'FULL';
      d.directStatus = 'FULL';
      d.reason = 'monthly_total_met';
    }
  } else {
    const sources: Array<{ date: string; remainingMs: number }> = [];
    for (const d of eligible) {
      if (d.cappedMs >= fullLowerMs) {
        d.status = 'FULL';
        d.directStatus = 'FULL';
        d.reason = 'direct_full';
        d.carryOutMs = Math.max(0, d.cappedMs - fullLowerMs);
      } else if (d.cappedMs >= halfLowerMs) {
        d.status = 'HALF';
        d.directStatus = 'HALF';
        d.reason = 'direct_half';
        d.carryOutMs = Math.max(0, d.cappedMs - halfLowerMs);
      } else {
        d.status = 'OFF';
        d.directStatus = 'OFF';
        d.reason = 'below_half';
        d.carryOutMs = d.cappedMs;
      }
      if (d.carryOutMs > 0) sources.push({ date: d.date, remainingMs: d.carryOutMs });
    }

    const applyCarryUpgrade = (candidate: {
      day: PayrollDayClassification;
      expected: PayrollDayStatus;
      target: 'FULL' | 'HALF';
      needMs: number;
      reason: PayrollCarryLedger['reason'];
    }) => {
      if (candidate.day.status !== candidate.expected) return;
      if (sumSourceMs(sources) < candidate.needMs) return;
      const consumed = consumeSources(sources, candidate.needMs, candidate.day.date, candidate.reason);
      for (const item of consumed) {
        carryLedger.push({ fromDate: item.fromDate, toDate: candidate.day.date, ms: item.ms, reason: candidate.reason });
      }
      candidate.day.carryInMs += candidate.needMs;
      candidate.day.status = candidate.target;
      candidate.day.reason = candidate.target === 'FULL' ? 'carried_to_full' : 'carried_to_half';
    };

    const halfToFull = () =>
      eligible
        .filter((d) => d.status === 'HALF')
        .sort((a, b) => a.date.localeCompare(b.date))
        .forEach((day) =>
          applyCarryUpgrade({
            day,
            expected: 'HALF',
            target: 'FULL',
            needMs: fullLowerMs - halfLowerMs,
            reason: 'upgrade_to_full',
          }),
        );

    halfToFull();
    eligible
      .filter((d) => d.status === 'OFF' && d.cappedMs > 0)
      .sort((a, b) => a.date.localeCompare(b.date))
      .forEach((day) =>
        applyCarryUpgrade({
          day,
          expected: 'OFF',
          target: 'HALF',
          needMs: halfLowerMs,
          reason: 'upgrade_to_half',
        }),
      );
    halfToFull();

    const remainingByDate = new Map<string, number>();
    for (const s of sources) remainingByDate.set(s.date, (remainingByDate.get(s.date) ?? 0) + s.remainingMs);
    for (const d of eligible) d.carryOutMs = remainingByDate.get(d.date) ?? 0;
  }

  const fullDays = days.filter((d) => d.status === 'FULL').length;
  const halfDays = days.filter((d) => d.status === 'HALF').length;
  const offDays = days.filter((d) => d.status === 'OFF').length;
  return {
    days,
    carryLedger,
    rawMs,
    cappedMs,
    ignoredOverflowMs,
    eligibleDays: eligible.length,
    fullDays,
    halfDays,
    offDays,
    scheduledOffDays: days.filter((d) => d.status === 'SCHEDULED_OFF').length,
    noShiftDays: days.filter((d) => d.status === 'NO_SHIFT').length,
    payableUnits: fullDays + halfDays * 0.5,
    monthlyGuarantee,
  };
}

function sumSourceMs(sources: Array<{ remainingMs: number }>): number {
  return sources.reduce((sum, s) => sum + s.remainingMs, 0);
}

function consumeSources(
  sources: Array<{ date: string; remainingMs: number }>,
  needMs: number,
  toDate: string,
  reason: PayrollCarryLedger['reason'],
): Array<{ fromDate: string; ms: number }> {
  const consumed: Array<{ fromDate: string; ms: number }> = [];
  let remaining = needMs;
  const sorted = [
    ...sources.filter((s) => s.date === toDate),
    ...sources.filter((s) => s.date !== toDate),
  ];
  for (const source of sorted) {
    if (remaining <= 0) break;
    if (source.remainingMs <= 0) continue;
    const take = Math.min(source.remainingMs, remaining);
    source.remainingMs -= take;
    remaining -= take;
    consumed.push({ fromDate: source.date, ms: take });
  }
  if (remaining > 0) {
    throw new Error(`payroll carry allocator underflow for ${reason}`);
  }
  return consumed;
}

type PayrollShiftForDay =
  | { kind: 'working'; shiftName: string | null }
  | { kind: 'scheduled_off'; shiftName: string | null }
  | { kind: 'no_shift' };

function resolvePayrollShiftForDay(
  date: string,
  tz: string,
  assignments: PayrollShiftAssignmentInput[],
): PayrollShiftForDay {
  const win = localDayWindow(date, tz);
  if (!win) return { kind: 'no_shift' };
  const startMs = win.start.getTime();
  const endMs = win.end.getTime();
  const assignment = assignments
    .filter((a) => a.effectiveFrom.getTime() < endMs && (a.effectiveTo === null || a.effectiveTo.getTime() > startMs))
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0] ?? null;
  if (!assignment?.shiftId) return { kind: 'no_shift' };
  const parsed = ShiftScheduleSchema.safeParse(assignment.scheduleSnapshot);
  if (!parsed.success) return { kind: 'no_shift' };
  const day = parsed.data[weekdayForDate(date)];
  if (!day) return { kind: 'scheduled_off', shiftName: assignment.shiftNameSnapshot };
  return { kind: 'working', shiftName: assignment.shiftNameSnapshot };
}

function weekdayForDate(date: string): (typeof WEEKDAYS)[number] {
  const [yy, mm, dd] = date.split('-').map((n) => parseInt(n, 10));
  return WEEKDAYS[new Date(Date.UTC(yy!, mm! - 1, dd!)).getUTCDay()]!;
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
    'Raw payroll hours',
    'Capped payroll hours',
    'Ignored overflow hours',
    'Eligible days',
    'Full days',
    'Half days',
    'Off days',
    'Payable units',
    'Monthly guarantee',
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
        r.rawHours.toFixed(2),
        r.cappedHours.toFixed(2),
        r.ignoredOverflowHours.toFixed(2),
        r.eligibleDays,
        r.fullDays,
        r.halfDays,
        r.offDays,
        r.payableUnits.toFixed(2),
        r.monthlyGuarantee ? 'yes' : 'no',
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
      p.totals.rawHours.toFixed(2),
      p.totals.cappedHours.toFixed(2),
      p.totals.ignoredOverflowHours.toFixed(2),
      p.totals.eligibleDays,
      p.totals.fullDays,
      p.totals.halfDays,
      p.totals.offDays,
      p.totals.payableUnits.toFixed(2),
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
