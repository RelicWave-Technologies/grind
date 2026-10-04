/**
 * Monthly payroll worksheet — a trimmed port of apps/api/src/payroll/monthly.ts:
 * cap each day, classify Full / Half / Off against the policy, honour the
 * monthly guarantee, and carry surplus into near-miss days.
 */
import { holidayOn } from './activity';
import { dayWindow, daysInRange, HOUR, iso, MIN, monthBounds, todayKey } from './clock';
import type { DbUser } from './db';
import { computeDay, effectiveShift, reportUsers, teamNameOf } from './derive';
import type { Ctx } from './http';

type PayrollDayStatus = 'FULL' | 'HALF' | 'OFF' | 'SCHEDULED_OFF' | 'NO_SHIFT';

interface PayrollDay {
  date: string;
  rawMs: number;
  cappedMs: number;
  ignoredOverflowMs: number;
  eligible: boolean;
  shiftName: string | null;
  status: PayrollDayStatus;
  directStatus: PayrollDayStatus;
  reason: string;
  carryInMs: number;
  carryOutMs: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const hours = (ms: number) => r2(ms / HOUR);

export function payrollRow(ctx: Ctx, u: DbUser, dates: string[]) {
  const p = ctx.db.payrollPolicy;
  const shift = effectiveShift(ctx, u);
  const days: PayrollDay[] = [];
  let worked = 0;
  let meeting = 0;
  let manual = 0;
  let present = 0;
  for (const date of dates) {
    const c = computeDay(ctx, u, date, 'shift');
    const rawMs = c.totals.workedMs + c.totals.meetingMs + c.totals.manualMs;
    worked += c.totals.workedMs;
    meeting += c.totals.meetingMs;
    manual += c.totals.manualMs;
    if (rawMs > 0) present += 1;
    const cappedMs = Math.min(rawMs, p.fullDayUpperMin * MIN);
    const base = { date, rawMs, cappedMs, ignoredOverflowMs: rawMs - cappedMs, carryInMs: 0, carryOutMs: 0 };
    if (!shift) {
      days.push({ ...base, eligible: false, shiftName: null, status: 'NO_SHIFT', directStatus: 'NO_SHIFT', reason: 'no_shift' });
    } else if (!c.slot || holidayOn(ctx.db, u, date)) {
      days.push({ ...base, eligible: false, shiftName: shift.name, status: 'SCHEDULED_OFF', directStatus: 'SCHEDULED_OFF', reason: 'scheduled_off' });
    } else {
      days.push({ ...base, eligible: true, shiftName: shift.name, status: 'OFF', directStatus: 'OFF', reason: 'below_half' });
    }
  }
  const eligible = days.filter((d) => d.eligible);
  const cappedTotal = eligible.reduce((s, d) => s + d.cappedMs, 0);
  const monthlyGuarantee = eligible.length > 0 && cappedTotal >= p.monthlyLowerMin * MIN;
  if (monthlyGuarantee) {
    for (const d of eligible) {
      d.status = 'FULL';
      d.directStatus = 'FULL';
      d.reason = 'monthly_total_met';
    }
  } else {
    for (const d of eligible) {
      if (d.cappedMs >= p.fullDayLowerMin * MIN) {
        d.status = d.directStatus = 'FULL';
        d.reason = 'direct_full';
      } else if (d.cappedMs >= p.halfDayLowerMin * MIN) {
        d.status = d.directStatus = 'HALF';
        d.reason = 'direct_half';
      }
    }
    // Carry surplus from long days into half days that just missed full.
    const sources = eligible.filter((d) => d.status === 'FULL').map((d) => ({ d, left: d.cappedMs - p.fullDayLowerMin * MIN }));
    for (const d of eligible) {
      const need = d.status === 'HALF' ? p.fullDayLowerMin * MIN - d.cappedMs : d.status === 'OFF' ? p.halfDayLowerMin * MIN - d.cappedMs : 0;
      if (need <= 0 || need > 75 * MIN) continue;
      const pool = sources.reduce((s, x) => s + x.left, 0);
      if (pool < need) continue;
      let remaining = need;
      for (const src of sources) {
        const take = Math.min(src.left, remaining);
        if (take <= 0) continue;
        src.left -= take;
        src.d.carryOutMs += take;
        remaining -= take;
        if (remaining <= 0) break;
      }
      d.carryInMs = need;
      d.status = d.status === 'HALF' ? 'FULL' : 'HALF';
      d.reason = d.status === 'FULL' ? 'carried_to_full' : 'carried_to_half';
    }
  }
  const count = (s: PayrollDayStatus) => days.filter((d) => d.status === s).length;
  const rawTotal = days.reduce((s, d) => s + d.rawMs, 0);
  const total = worked + meeting + manual;
  return {
    user: { id: u.id, name: u.name, email: u.email, avatarUrl: u.avatarUrl, role: u.role, teamName: teamNameOf(ctx, u.teamId) },
    daysPresent: present,
    workedHours: hours(worked),
    meetingHours: hours(meeting),
    manualHours: hours(manual),
    totalHours: hours(total),
    avgDayHours: present ? hours(total / present) : 0,
    rawHours: hours(rawTotal),
    cappedHours: hours(cappedTotal),
    ignoredOverflowHours: hours(days.reduce((s, d) => s + d.ignoredOverflowMs, 0)),
    eligibleDays: eligible.length,
    fullDays: count('FULL'),
    halfDays: count('HALF'),
    offDays: count('OFF'),
    scheduledOffDays: count('SCHEDULED_OFF'),
    noShiftDays: count('NO_SHIFT'),
    payableUnits: count('FULL') + count('HALF') * 0.5,
    monthlyGuarantee,
    payrollDays: days,
  };
}

export function monthlyPayroll(ctx: Ctx, month: string) {
  const { from, to: monthEnd } = monthBounds(month);
  const today = todayKey();
  const to = monthEnd < today ? monthEnd : today;
  const dates = from <= to ? daysInRange(from, to) : [];
  const rows = dates.length ? reportUsers(ctx).map((u) => payrollRow(ctx, u, dates)) : [];
  const sum = (f: (r: (typeof rows)[number]) => number) => r2(rows.reduce((s, r) => s + f(r), 0));
  const runs = ctx.empty
    ? []
    : ctx.db.payrollRuns
        .filter((r) => r.month === month)
        .sort((a, b) => b.scheduledFor - a.scheduledFor)
        .map((r) => ({ ...r, scheduledFor: iso(r.scheduledFor), createdAt: iso(r.createdAt), errors: r.failedCount ? [{ userId: 'usr_aditya', error: 'lark_user_not_found' }] : null }));
  const monthStart = dayWindow(from).start;
  const monthEndMs = dayWindow(monthEnd).end;
  return {
    payroll: {
      month,
      tz: ctx.db.payrollPolicy.timezone,
      generatedAtMs: ctx.now,
      rows,
      totals: {
        daysPresent: sum((r) => r.daysPresent),
        workedHours: sum((r) => r.workedHours),
        meetingHours: sum((r) => r.meetingHours),
        manualHours: sum((r) => r.manualHours),
        totalHours: sum((r) => r.totalHours),
        rawHours: sum((r) => r.rawHours),
        cappedHours: sum((r) => r.cappedHours),
        ignoredOverflowHours: sum((r) => r.ignoredOverflowHours),
        eligibleDays: sum((r) => r.eligibleDays),
        fullDays: sum((r) => r.fullDays),
        halfDays: sum((r) => r.halfDays),
        offDays: sum((r) => r.offDays),
        payableUnits: sum((r) => r.payableUnits),
      },
    },
    policy: payrollPolicyDto(ctx),
    runs,
    unresolvedApprovalCount: ctx.empty
      ? 0
      : ctx.db.requests.filter((r) => r.status === 'PENDING' && r.start < monthEndMs && r.end > monthStart).length,
  };
}

export function payrollPolicyDto(ctx: Ctx) {
  const p = ctx.db.payrollPolicy;
  return {
    workspaceId: 'ws_saffronloop',
    halfDayLowerMin: p.halfDayLowerMin,
    halfDayUpperMin: p.halfDayUpperMin,
    fullDayLowerMin: p.fullDayLowerMin,
    fullDayUpperMin: p.fullDayUpperMin,
    monthlyLowerMin: p.monthlyLowerMin,
    timezone: p.timezone,
    approvalReminderDays: p.approvalReminderDays,
    approvalReminderTime: p.approvalReminderTime,
    payrollSheetSendDay: p.payrollSheetSendDay,
    payrollSheetSendTime: p.payrollSheetSendTime,
    sendPayrollSheetTo: p.sendPayrollSheetTo,
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
  };
}
