import {
  LEAVE_DAY_STEP,
  ShiftScheduleSchema,
  WEEKDAYS,
  portionDays,
  roundToHalfDay,
  type DayStatus,
  type LeaveKind,
  type LeavePortion,
} from '@grind/types';
import { localDayWindow } from '../insights/day';
import type { LeaveFundingDays } from './leaveFunding';

/**
 * The Working Calendar answers one question for a person and a date:
 *
 *   "Were they expected to work, and if not, why — and does it cost anybody
 *    anything?"
 *
 * Three sources feed it — the shift assignment in force that day, the company
 * holiday list, and approved leave — and it owns the precedence between them.
 * Keeping that precedence in one module is the point: the rule that *nobody is
 * charged for a day they were never expected to work* has to hold identically
 * in the request quote, the ledger write, the timesheet and the payroll
 * worksheet. Spread across four callers it would be four subtly different
 * rules, and the balances would disagree.
 *
 * Everything here is pure — no DB, no clock. Callers load the rows and hand
 * them in, which is what makes the precedence testable without a database.
 */

export interface ShiftAssignmentInput {
  shiftId: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  shiftNameSnapshot: string | null;
  scheduleSnapshot: unknown;
}

export interface HolidayInput {
  /** YYYY-MM-DD in the workspace's business timezone. */
  date: string;
  name: string;
  /** null = whole workspace; otherwise only members of this team. */
  teamId: string | null;
}

export interface ApprovedLeaveInput {
  userId: string;
  /** Inclusive YYYY-MM-DD range. */
  startDate: string;
  endDate: string;
  portion: LeavePortion;
  kind: LeaveKind;
  label: string | null;
}

export interface WorkingCalendarInput {
  tz: string;
  /**
   * Who takes the last Saturday of the month off, by user id.
   *
   * Per person rather than per workspace because only one of the two employers
   * sharing this workspace does it, and teams do not divide along company
   * lines. Applied only to somebody whose shift says they work that Saturday,
   * so it can never invent a working day for a person already off.
   */
  lastSaturdayOffFor?: Record<string, boolean>;
  /** Per-user shift assignment history, newest or oldest order both fine. */
  shiftAssignments?: Record<string, ShiftAssignmentInput[]>;
  /** Team each user belongs to, for team-scoped holidays. */
  userTeamIds?: Record<string, string | null>;
  holidays?: HolidayInput[];
  approvedLeave?: ApprovedLeaveInput[];
  /**
   * How far a balance reached on each paid-leave day that it did not cover
   * outright, by user.
   *
   * Resolved by `resolveLeaveFunding` rather than here: the answer needs a
   * running balance read in date order, and this class is queried in whatever
   * order a caller happens to render. Handed in finished so a day's status
   * stays independent of the order it was asked for.
   */
  leaveFunding?: LeaveFundingDays;
}

type ShiftForDay =
  | { kind: 'working'; shiftName: string | null }
  | { kind: 'weekly_off'; shiftName: string | null }
  | { kind: 'no_shift' };

/**
 * A resolved calendar. Built once per request over the range being rendered,
 * then queried per user-day — the day windows and holiday index are computed
 * up front so a 60-day × 40-person matrix does not recompute them 2400 times.
 */
export class WorkingCalendar {
  private readonly tz: string;
  private readonly shiftAssignments: Record<string, ShiftAssignmentInput[]>;
  private readonly userTeamIds: Record<string, string | null>;
  /** date -> holidays on that date (workspace-wide first). */
  private readonly holidaysByDate: Map<string, HolidayInput[]>;
  /** userId -> approved leave, in submission order. */
  private readonly leaveByUser: Map<string, ApprovedLeaveInput[]>;
  private readonly dayWindowCache = new Map<string, { startMs: number; endMs: number } | null>();

  private readonly lastSaturdayOffFor: Record<string, boolean>;
  /** userId -> date -> days of leave a balance covered, where it fell short. */
  private readonly leaveFunding: LeaveFundingDays;

  constructor(input: WorkingCalendarInput) {
    this.tz = input.tz;
    this.lastSaturdayOffFor = input.lastSaturdayOffFor ?? {};
    this.leaveFunding = input.leaveFunding ?? new Map();
    this.shiftAssignments = input.shiftAssignments ?? {};
    this.userTeamIds = input.userTeamIds ?? {};

    this.holidaysByDate = new Map();
    for (const h of input.holidays ?? []) {
      const list = this.holidaysByDate.get(h.date);
      if (list) list.push(h);
      else this.holidaysByDate.set(h.date, [h]);
    }

    this.leaveByUser = new Map();
    for (const l of input.approvedLeave ?? []) {
      const list = this.leaveByUser.get(l.userId);
      if (list) list.push(l);
      else this.leaveByUser.set(l.userId, [l]);
    }
  }

  /**
   * Status of one user-day, with precedence applied:
   *
   *   no shift  >  weekly off  >  company holiday  >  approved leave  >  working
   *
   * The first three all cost 0 days, so leave that lands on them is free. That
   * is deliberate and is the rule the whole feature hangs on.
   */
  dayStatus(userId: string, date: string): DayStatus {
    const shift = this.resolveShiftForDay(userId, date);

    if (shift.kind === 'no_shift') {
      return base(date, 'NO_SHIFT', { shiftName: null });
    }
    if (shift.kind === 'weekly_off') {
      return base(date, 'WEEKLY_OFF', { shiftName: shift.shiftName });
    }

    const holiday = this.holidayFor(userId, date);
    if (holiday) {
      // Paid for everyone, and it must not touch anybody's balance.
      return {
        ...base(date, 'HOLIDAY', { shiftName: shift.shiftName }),
        paid: true,
        label: holiday.name,
      };
    }

    const leave = this.leaveFor(userId, date);
    if (leave) {
      const away = portionDays(leave.portion);
      // Approved as paid, but only paid as far as a balance reached. The ledger
      // still debited the whole day and is still allowed to sit negative — the
      // balance says how far someone is overdrawn, this says which days it did
      // not reach, and a day it reached halfway is both at once.
      const shortfall = leave.kind === 'PAID' ? this.leaveFunding.get(userId)?.get(date) : 0;
      const fundedDays = shortfall ?? (leave.kind === 'PAID' ? away : 0);
      const paid = fundedDays > 0;
      return {
        date,
        kind: paid ? 'PAID_LEAVE' : 'UNPAID_LEAVE',
        portion: leave.portion,
        paid,
        fundedDays,
        // Unpaid leave costs no balance because it costs no money. "charged"
        // and "paid" are two different columns and conflating them is the
        // easiest way to get this wrong.
        chargedDays: paid ? away : 0,
        expectedFraction: roundToHalfDay(1 - away),
        shiftName: shift.shiftName,
        label: leave.label,
      };
    }

    return { ...base(date, 'WORKING', { shiftName: shift.shiftName }), expectedFraction: 1 };
  }

  /**
   * What this day bills a balance before anybody argues with it — no funding,
   * no correction, just the shift, the holiday list and the leave on file.
   *
   * `chargedDays` on a DayStatus cannot answer this any more: it went to zero
   * the moment the balance failed to reach the day. Reconciling a correction
   * needs the bill that was actually raised, so it can hand back exactly that
   * and no more.
   */
  leaveChargeFor(userId: string, date: string): number {
    if (!this.isChargeableDay(userId, date)) return 0;
    const leave = this.leaveFor(userId, date);
    if (!leave || leave.kind !== 'PAID') return 0;
    return portionDays(leave.portion);
  }

  /**
   * Whether this day can cost a balance anything at all.
   *
   * A weekly off, a holiday and a day with no shift are free, and that sits
   * above every other rule — a correction cannot reach past it either.
   */
  isChargeableDay(userId: string, date: string): boolean {
    const shift = this.resolveShiftForDay(userId, date);
    if (shift.kind !== 'working') return false;
    return this.holidayFor(userId, date) === null;
  }

  /**
   * How many days of this date's leave a balance covered, or undefined when it
   * covered the whole cost.
   *
   * The report needs this for a day a manager called leave: the correction says
   * the day was half a day away, and only the balance can say whether that half
   * was paid. Undefined rather than the cost itself, because "covered" is the
   * common answer and the caller knows what it asked for.
   */
  fundedDaysFor(userId: string, date: string): number | undefined {
    return this.leaveFunding.get(userId)?.get(date);
  }

  /** Status for a whole range, in date order. */
  dayStatuses(userId: string, dates: readonly string[]): DayStatus[] {
    return dates.map((d) => this.dayStatus(userId, d));
  }

  /**
   * What a prospective PAID leave range would cost this person, ignoring any
   * leave already approved for those dates. This is the pricing used both when
   * quoting a request and when writing the consumption entry on approval, so
   * the number the requester saw is the number that gets charged.
   */
  quote(input: {
    userId: string;
    dates: readonly string[];
    portion: LeavePortion;
    kind: LeaveKind;
  }): { chargedDays: number; days: DayStatus[] } {
    const days: DayStatus[] = [];
    let charged = 0;

    for (const date of input.dates) {
      const shift = this.resolveShiftForDay(input.userId, date);
      if (shift.kind === 'no_shift') {
        days.push(base(date, 'NO_SHIFT', { shiftName: null }));
        continue;
      }
      if (shift.kind === 'weekly_off') {
        days.push(base(date, 'WEEKLY_OFF', { shiftName: shift.shiftName }));
        continue;
      }
      const holiday = this.holidayFor(input.userId, date);
      if (holiday) {
        days.push({
          ...base(date, 'HOLIDAY', { shiftName: shift.shiftName }),
          paid: true,
          label: holiday.name,
        });
        continue;
      }

      const away = portionDays(input.portion);
      const paid = input.kind === 'PAID';
      const cost = paid ? away : 0;
      charged += cost;
      days.push({
        date,
        kind: paid ? 'PAID_LEAVE' : 'UNPAID_LEAVE',
        portion: input.portion,
        paid,
        chargedDays: cost,
        expectedFraction: roundToHalfDay(1 - away),
        shiftName: shift.shiftName,
        label: null,
      });
    }

    return { chargedDays: roundToHalfDay(charged), days };
  }

  // -------------------------------------------------------------------------

  private holidayFor(userId: string, date: string): HolidayInput | null {
    const list = this.holidaysByDate.get(date);
    if (!list?.length) return null;
    const teamId = this.userTeamIds[userId] ?? null;
    // Workspace-wide entries apply to everyone; team entries only to that team.
    return list.find((h) => h.teamId === null || h.teamId === teamId) ?? null;
  }

  private leaveFor(userId: string, date: string): ApprovedLeaveInput | null {
    const list = this.leaveByUser.get(userId);
    if (!list?.length) return null;
    return list.find((l) => date >= l.startDate && date <= l.endDate) ?? null;
  }

  private dayWindow(date: string): { startMs: number; endMs: number } | null {
    const cached = this.dayWindowCache.get(date);
    if (cached !== undefined) return cached;
    const win = localDayWindow(date, this.tz);
    const value = win ? { startMs: win.start.getTime(), endMs: win.end.getTime() } : null;
    this.dayWindowCache.set(date, value);
    return value;
  }

  private resolveShiftForDay(userId: string, date: string): ShiftForDay {
    const assignments = this.shiftAssignments[userId];
    if (!assignments?.length) return { kind: 'no_shift' };
    const win = this.dayWindow(date);
    if (!win) return { kind: 'no_shift' };

    const assignment =
      assignments
        .filter(
          (a) =>
            a.effectiveFrom.getTime() < win.endMs &&
            (a.effectiveTo === null || a.effectiveTo.getTime() > win.startMs),
        )
        .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0] ?? null;

    if (!assignment?.shiftId) return { kind: 'no_shift' };
    const parsed = ShiftScheduleSchema.safeParse(assignment.scheduleSnapshot);
    if (!parsed.success) return { kind: 'no_shift' };
    const day = parsed.data[weekdayForDate(date)];
    if (!day) return { kind: 'weekly_off', shiftName: assignment.shiftNameSnapshot };
    // Resolved here rather than at each caller, so "was this a working day"
    // has one answer for the quote, the timesheet and the payroll worksheet.
    if (this.lastSaturdayOffFor[userId] && isLastSaturdayOfMonth(date)) {
      return { kind: 'weekly_off', shiftName: assignment.shiftNameSnapshot };
    }
    return { kind: 'working', shiftName: assignment.shiftNameSnapshot };
  }
}

function base(
  date: string,
  kind: DayStatus['kind'],
  opts: { shiftName: string | null },
): DayStatus {
  return {
    date,
    kind,
    portion: null,
    paid: false,
    chargedDays: 0,
    expectedFraction: 0,
    shiftName: opts.shiftName,
    label: null,
  };
}

/**
 * Is this the last Saturday of its month?
 *
 * The shift schedule is a weekly pattern — seven keys, one per weekday — so it
 * cannot express "the last Saturday". This is the exception that needs its own
 * rule: the team works a six-day week, and one Saturday a month is not a working
 * day. Pure date arithmetic, no clock, so it is the same answer everywhere.
 */
export function isLastSaturdayOfMonth(date: string): boolean {
  if (weekdayForDate(date) !== 'sat') return false;
  const [yy, mm, dd] = date.split('-').map((n) => Number.parseInt(n, 10));
  // Day 0 of the next month is the last day of this one.
  const lastDay = new Date(Date.UTC(yy!, mm!, 0)).getUTCDate();
  // The last Saturday is the only one within seven days of the month's end.
  return dd! + 7 > lastDay;
}

/** Weekday key for a YYYY-MM-DD business date (calendar date, not an instant). */
export function weekdayForDate(date: string): (typeof WEEKDAYS)[number] {
  const [yy, mm, dd] = date.split('-').map((n) => Number.parseInt(n, 10));
  return WEEKDAYS[new Date(Date.UTC(yy!, mm! - 1, dd!)).getUTCDay()]!;
}

/** Inclusive YYYY-MM-DD range, capped so pathological input cannot spin. */
export function leaveDateRange(from: string, to: string, maxDays = 400): string[] {
  const out: string[] = [];
  let cur = from;
  for (let i = 0; i < maxDays; i++) {
    if (cur > to) break;
    out.push(cur);
    if (cur === to) break;
    cur = addIsoDays(cur, 1);
  }
  return out;
}

/** Add whole days to a YYYY-MM-DD string, staying on the calendar grid. */
export function addIsoDays(date: string, delta: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** Half a day, exported so callers never hand-write the literal. */
export const HALF_DAY = LEAVE_DAY_STEP;
