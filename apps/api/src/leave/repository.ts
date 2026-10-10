import { prisma, type Prisma } from '@grind/db';
import {
  ATTENDANCE_RULE_DEFAULTS,
  ATTENDANCE_RULE_LABEL,
  ATTENDANCE_RULE_REASON,
  AttendanceRuleTagSchema,
  attendanceOverrideShape,
  dateKeyInTimeZone,
  LEAVE_POLICY_DEFAULTS,
  roundToHalfDay,
  type AttendanceOverrideCode,
  type LeavePolicyDto,
} from '@grind/types';
import { WorkingCalendar, type ShiftAssignmentInput } from './workingCalendar';
import { projectBalance, type LeaveLedgerEntry } from './ledger';
import {
  resolveLeaveAccounts,
  resolveLeaveFunding,
  type ChargeableLeaveDay,
  type LeaveCredit,
} from './leaveFunding';
import { RULE_SOURCE_PREFIX } from '../attendance/ruleLedger';

/**
 * The seam between the database and the two pure modules.
 *
 * Everything above this file works on plain values — `WorkingCalendar` and the
 * ledger projection never see Prisma — and everything below it is row loading.
 * That is what lets the precedence rules and the balance arithmetic be tested
 * without a database, and it is why this file has no logic worth testing of
 * its own beyond "did we load the right rows".
 */

type Tx = Prisma.TransactionClient;

/** Earlier than any leave Timo holds, for a workspace with no ledger start. */
const WHOLE_HISTORY_FROM = '2000-01-01';

/** A `Date` from a Postgres `date` column, as YYYY-MM-DD. */
export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * The day a person's leave starts accruing: `joinedOn` when somebody set it,
 * otherwise the day their Timo account was created — in the workspace's
 * calendar. `createdAt` is an instant, and its UTC date is the day before for
 * anybody added in the first hours of an IST morning.
 */
export function accrualStartDate(user: { joinedOn: Date | null; createdAt: Date }, tz: string): string {
  return user.joinedOn ? toIsoDate(user.joinedOn) : dateKeyInTimeZone(user.createdAt, tz);
}

/** YYYY-MM-DD to the UTC midnight `Date` a `date` column round-trips to. */
export function fromIsoDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export async function loadOrCreateLeavePolicy(workspaceId: string, db: Tx | typeof prisma = prisma) {
  const existing = await db.leavePolicy.findUnique({ where: { workspaceId } });
  if (existing) return existing;
  return db.leavePolicy.create({ data: { workspaceId, ...LEAVE_POLICY_DEFAULTS } });
}

export function toLeavePolicyDto(row: {
  monthlyAccrualDays: number;
  carryForward: boolean;
  carryForwardCapDays: number | null;
  allowNegativeBalance: boolean;
  accrueOnJoinMonth: boolean;
  ledgerStartMonth?: string | null;
  birthdayLeaveDays?: number;
  attendanceRulesFrom?: string | null;
  fullDayMinMinutes?: number;
  halfDayMinMinutes?: number;
  wfhRequiresApproval?: boolean;
  lateAllowedPerMonth?: number;
  lateGraceMinutes?: number;
  halfDayLateAfterMinute?: number;
  updatedAt: Date;
}): LeavePolicyDto {
  return {
    monthlyAccrualDays: row.monthlyAccrualDays,
    carryForward: row.carryForward,
    carryForwardCapDays: row.carryForwardCapDays,
    allowNegativeBalance: row.allowNegativeBalance,
    ledgerStartMonth: row.ledgerStartMonth ?? null,
    birthdayLeaveDays: row.birthdayLeaveDays ?? 0,
    accrueOnJoinMonth: row.accrueOnJoinMonth,
    attendanceRulesFrom: row.attendanceRulesFrom ?? ATTENDANCE_RULE_DEFAULTS.attendanceRulesFrom,
    fullDayMinMinutes: row.fullDayMinMinutes ?? ATTENDANCE_RULE_DEFAULTS.fullDayMinMinutes,
    halfDayMinMinutes: row.halfDayMinMinutes ?? ATTENDANCE_RULE_DEFAULTS.halfDayMinMinutes,
    wfhRequiresApproval: row.wfhRequiresApproval ?? ATTENDANCE_RULE_DEFAULTS.wfhRequiresApproval,
    lateAllowedPerMonth: row.lateAllowedPerMonth ?? ATTENDANCE_RULE_DEFAULTS.lateAllowedPerMonth,
    lateGraceMinutes: row.lateGraceMinutes ?? ATTENDANCE_RULE_DEFAULTS.lateGraceMinutes,
    halfDayLateAfterMinute: row.halfDayLateAfterMinute ?? ATTENDANCE_RULE_DEFAULTS.halfDayLateAfterMinute,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Build the Working Calendar covering `userIds` over `[from, to]`.
 *
 * Approved leave is fetched with an overlap predicate rather than a
 * containment one, so a request that starts before the window and ends inside
 * it still marks its days.
 *
 * The window is then widened backwards to the ledger's start month, because
 * whether September's leave was paid depends on what August's leave already
 * spent. Asking only about the month on screen would let the same day read as
 * paid in one report and unpaid in another.
 */
export async function loadWorkingCalendar(input: {
  workspaceId: string;
  tz: string;
  userIds: string[];
  from: string;
  to: string;
  db?: Tx | typeof prisma;
}): Promise<WorkingCalendar> {
  const db = input.db ?? prisma;

  // Loaded before the rest rather than alongside it: the ledger start month
  // decides how far back the other queries have to reach.
  const policy = await loadOrCreateLeavePolicy(input.workspaceId, db);
  const fundingFloor = policy.ledgerStartMonth ? `${policy.ledgerStartMonth}-01` : undefined;
  // With no ledger start, every credit since joining counts toward the balance,
  // so every leave day since then has to be spent against it too — loading
  // only the visible window would leave old leave unspent and the balance high.
  const loadFrom = fundingFloor
    ? (fundingFloor < input.from ? fundingFloor : input.from)
    : WHOLE_HISTORY_FROM;

  const fromDate = fromIsoDate(loadFrom);
  const toDate = fromIsoDate(input.to);

  const [users, assignments, holidays, leave, credits, overrides, ruleCharges] = await Promise.all([
    db.user.findMany({
      where: { id: { in: input.userIds } },
      select: {
        id: true,
        teamId: true,
        lastSaturdayOffOverride: true,
        joinedOn: true,
        createdAt: true,
        deactivatedAt: true,
      },
    }),
    db.shiftAssignment.findMany({
      where: {
        userId: { in: input.userIds },
        effectiveFrom: { lte: toDate },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: fromDate } }],
      },
      select: {
        userId: true,
        shiftId: true,
        effectiveFrom: true,
        effectiveTo: true,
        shiftNameSnapshot: true,
        scheduleSnapshot: true,
      },
    }),
    db.companyHoliday.findMany({
      where: { workspaceId: input.workspaceId, date: { gte: fromDate, lte: toDate } },
      select: { date: true, name: true, teamId: true },
    }),
    db.leaveRequest.findMany({
      where: {
        workspaceId: input.workspaceId,
        userId: { in: input.userIds },
        status: 'APPROVED',
        startDate: { lte: toDate },
        endDate: { gte: fromDate },
      },
      select: {
        userId: true,
        startDate: true,
        endDate: true,
        portion: true,
        kind: true,
        reason: true,
      },
    }),
    // Only what adds to a balance. Consumption is deliberately left out: the
    // walk below re-spends the leave day by day, and reading the debits too
    // would charge every day twice.
    db.leaveLedgerEntry.findMany({
      where: {
        userId: { in: input.userIds },
        kind: { in: ['ACCRUAL', 'ADJUSTMENT'] },
        effectiveOn: { lte: toDate },
        // The entries a correction wrote are left out on purpose. They exist so
        // the statement agrees with the report about what a corrected day cost;
        // the walk below already prices that day from the correction itself, and
        // reading the entry too would spend the same half day twice.
        NOT: { sourceKey: { startsWith: 'override:' } },
      },
      select: { userId: true, effectiveOn: true, days: true, sourceKey: true, reason: true },
    }),
    // A manager's correction is a fact about the day, so the balance has to
    // spend against it the same way it spends against Lark's leave. Loaded
    // over the funding window, not the visible one: a correction in August
    // decides what is left for September.
    db.attendanceOverride.findMany({
      where: {
        userId: { in: input.userIds },
        date: { gte: fromDate, lte: toDate },
      },
      select: { userId: true, date: true, code: true },
    }),
    // Days the attendance rules turned into leave. They spend the balance the
    // way Lark's leave does, so they join the walk below — priced from the line
    // itself, which the rule reconcile keeps in step with the verdict.
    db.leaveLedgerEntry.findMany({
      where: {
        userId: { in: input.userIds },
        sourceKey: { startsWith: RULE_SOURCE_PREFIX },
        effectiveOn: { gte: fromDate, lte: toDate },
      },
      select: { userId: true, effectiveOn: true, days: true, reason: true },
    }),
  ]);

  const userTeamIds: Record<string, string | null> = {};
  const lastSaturdayOffFor: Record<string, boolean> = {};
  for (const u of users) {
    userTeamIds[u.id] = u.teamId;
    // The person's own answer wins; the workspace policy is the fallback.
    lastSaturdayOffFor[u.id] = u.lastSaturdayOffOverride ?? policy.lastSaturdayOff;
  }

  // A suspended person's shift ends when they were suspended: the day itself
  // still counts, every day after has no shift — so it is "--" on the sheet, no
  // rule charges it and no balance pays for it.
  const deactivatedAt = new Map(users.flatMap((u) => (u.deactivatedAt ? [[u.id, u.deactivatedAt] as const] : [])));
  const shiftAssignments: Record<string, ShiftAssignmentInput[]> = {};
  for (const a of assignments) {
    const endedAt = deactivatedAt.get(a.userId);
    if (endedAt && a.effectiveFrom >= endedAt) continue;
    const effectiveTo = endedAt && (a.effectiveTo === null || a.effectiveTo > endedAt) ? endedAt : a.effectiveTo;
    (shiftAssignments[a.userId] ??= []).push({
      shiftId: a.shiftId,
      effectiveFrom: a.effectiveFrom,
      effectiveTo,
      shiftNameSnapshot: a.shiftNameSnapshot,
      scheduleSnapshot: a.scheduleSnapshot,
    });
  }

  const shared = {
    tz: input.tz,
    lastSaturdayOffFor,
    shiftAssignments,
    userTeamIds,
    holidays: holidays.map((h) => ({ date: toIsoDate(h.date), name: h.name, teamId: h.teamId })),
    approvedLeave: leave.map((l) => ({
      userId: l.userId,
      startDate: toIsoDate(l.startDate),
      endDate: toIsoDate(l.endDate),
      portion: l.portion,
      kind: l.kind,
      label: l.kind === 'PAID' ? 'Paid leave' : 'Unpaid leave',
    })),
  };

  // Built twice, from one set of rows. The first pass prices each leave day —
  // a day that was already a weekly off or a holiday costs nothing, and that
  // rule lives in the calendar, not here. The second pass is the same calendar
  // told which of those days the balance failed to cover. Constructing is just
  // indexing, so the second one costs nothing worth avoiding.
  const priced = new WorkingCalendar(shared);

  const accrualStartFor: Record<string, string | undefined> = {};
  for (const u of users) accrualStartFor[u.id] = accrualStartDate(u, input.tz);

  const overrideFor = new Map<string, AttendanceOverrideCode>();
  for (const o of overrides) overrideFor.set(`${o.userId}\u0000${toIsoDate(o.date)}`, o.code);

  /**
   * What one day costs the balance, with a manager's correction on top.
   *
   * A correction replaces the answer outright rather than adding to it: told a
   * day was Present, the balance must stop paying for the leave Lark recorded,
   * and told a day was a paid half, it must start paying for one nobody filed.
   * Days off still cost nothing — that rule sits above every other, and a
   * correction cannot reach past it.
   */
  const ruleCostFor = new Map<string, number>();
  const ruleReasonFor = new Map<string, string>();
  for (const r of ruleCharges) {
    ruleCostFor.set(`${r.userId}\u0000${toIsoDate(r.effectiveOn)}`, -r.days);
    if (r.reason) ruleReasonFor.set(`${r.userId}\u0000${toIsoDate(r.effectiveOn)}`, r.reason);
  }

  /** Why a day was leave, in words — for the leave details list. */
  const labelOf = (userId: string, date: string): string => {
    const key = `${userId}\u0000${date}`;
    if (overrideFor.has(key)) return 'Changed by a manager';
    const status = priced.dayStatus(userId, date);
    const parts: string[] = [];
    if (status.chargedDays > 0) parts.push(status.portion === 'FULL' ? 'Leave (Lark)' : 'Half-day leave (Lark)');
    const rule = ruleReasonFor.get(key);
    if (rule) {
      // The ledger line holds the full sentence; the list wants the few words.
      const tag = AttendanceRuleTagSchema.options.find((t) => ATTENDANCE_RULE_LABEL[t] === rule);
      parts.push(tag ? ATTENDANCE_RULE_REASON[tag] : rule);
    }
    return parts.join(' + ') || 'Leave';
  };

  const costOf = (userId: string, date: string): number => {
    const status = priced.dayStatus(userId, date);
    const free = status.kind === 'WEEKLY_OFF' || status.kind === 'HOLIDAY' || status.kind === 'NO_SHIFT';
    if (free) return 0;
    const override = overrideFor.get(`${userId}\u0000${date}`);
    // A rule's leave sits on top of whatever was approved: half a day of
    // approved leave plus half a day the rule added is a whole day spent.
    if (!override) return roundToHalfDay(status.chargedDays + (ruleCostFor.get(`${userId}\u0000${date}`) ?? 0));
    switch (attendanceOverrideShape(override)) {
      case 'FULL_LEAVE': return 1;
      case 'HALF_LEAVE': return 0.5;
      // Present or absent: whatever Lark recorded here, the balance stops
      // paying for it.
      default: return 0;
    }
  };

  const charged = new Set<string>();
  const leaveDays: ChargeableLeaveDay[] = [];
  const chargeDay = (userId: string, date: string) => {
    const key = `${userId}\u0000${date}`;
    if (charged.has(key)) return;
    charged.add(key);
    leaveDays.push({ userId, date, cost: costOf(userId, date), label: labelOf(userId, date) });
  };

  for (const l of shared.approvedLeave) {
    if (l.kind !== 'PAID') continue;
    for (const date of datesBetween(l.startDate, l.endDate)) {
      if (date > input.to) break;
      chargeDay(l.userId, date);
    }
  }
  // A day nobody filed leave for, that a manager called paid leave anyway.
  for (const o of overrides) chargeDay(o.userId, toIsoDate(o.date));
  // A day a rule charged, which usually has no leave filed against it either.
  for (const r of ruleCharges) chargeDay(r.userId, toIsoDate(r.effectiveOn));

  const creditRows: LeaveCredit[] = credits.map((c) => ({
    userId: c.userId,
    effectiveOn: toIsoDate(c.effectiveOn),
    days: c.days,
    label: creditLabel(c.sourceKey, c.days, c.reason),
  }));

  const walk = { credits: creditRows, leaveDays, since: fundingFloor, accrualStartFor };
  return new WorkingCalendar({
    ...shared,
    leaveFunding: resolveLeaveFunding(walk),
    leaveAccounts: resolveLeaveAccounts({ ...walk, from: input.from, to: input.to }),
  });
}

/** A ledger credit in words, for the leave details list. */
function creditLabel(sourceKey: string, days: number, reason: string | null): string {
  if (sourceKey.startsWith('accrual:')) return 'Monthly leave';
  if (sourceKey.startsWith('birthday:')) return 'Birthday leave';
  if (sourceKey.startsWith('leave-reversal:')) return 'Leave cancelled — returned';
  const who = days >= 0 ? 'Added by admin' : 'Removed by admin';
  return reason ? `${who}: ${reason}` : who;
}

/** Every YYYY-MM-DD from `start` to `end`, inclusive. */
function* datesBetween(start: string, end: string): Generator<string> {
  const DAY_MS = 24 * 60 * 60 * 1000;
  let t = Date.parse(`${start}T00:00:00.000Z`);
  const last = Date.parse(`${end}T00:00:00.000Z`);
  // A malformed bound would otherwise spin forever.
  if (!Number.isFinite(t) || !Number.isFinite(last)) return;
  while (t <= last) {
    yield new Date(t).toISOString().slice(0, 10);
    t += DAY_MS;
  }
}

/** Ledger rows for one person, oldest first, as the pure projection wants them. */
export async function loadLedgerEntries(
  userId: string,
  db: Tx | typeof prisma = prisma,
): Promise<LeaveLedgerEntry[]> {
  const rows = await db.leaveLedgerEntry.findMany({
    where: { userId },
    orderBy: [{ effectiveOn: 'asc' }, { createdAt: 'asc' }],
    select: { kind: true, days: true, effectiveOn: true, reason: true },
  });
  return rows.map((r) => ({
    kind: r.kind,
    days: r.days,
    effectiveOn: toIsoDate(r.effectiveOn),
    reason: r.reason,
  }));
}

/**
 * First date that counts toward a balance, from the workspace policy.
 *
 * Read here rather than passed in by every caller: a balance computed with the
 * floor in one screen and without it in another is exactly the kind of drift
 * that makes two pages disagree about what somebody is owed.
 */
async function ledgerFloor(
  workspaceId: string | null,
  db: Tx | typeof prisma = prisma,
): Promise<string | undefined> {
  if (!workspaceId) return undefined;
  const policy = await loadOrCreateLeavePolicy(workspaceId, db);
  return policy.ledgerStartMonth ? `${policy.ledgerStartMonth}-01` : undefined;
}

/** Balance for one person as of a date. */
export async function loadBalance(
  userId: string,
  asOf?: string,
  db: Tx | typeof prisma = prisma,
) {
  const user = await db.user.findUnique({ where: { id: userId }, select: { workspaceId: true } });
  const since = await ledgerFloor(user?.workspaceId ?? null, db);
  return projectBalance(await loadLedgerEntries(userId, db), asOf, since);
}

/**
 * Balances for many people in one query — the month-end report needs a column
 * per person and must not issue a query each.
 */
export async function loadBalances(
  userIds: string[],
  asOf: string,
  db: Tx | typeof prisma = prisma,
): Promise<Record<string, ReturnType<typeof projectBalance>>> {
  const first = userIds.length
    ? await db.user.findFirst({ where: { id: { in: userIds } }, select: { workspaceId: true } })
    : null;
  const since = await ledgerFloor(first?.workspaceId ?? null, db);
  const rows = await db.leaveLedgerEntry.findMany({
    where: { userId: { in: userIds }, effectiveOn: { lte: fromIsoDate(asOf) } },
    orderBy: [{ effectiveOn: 'asc' }, { createdAt: 'asc' }],
    select: { userId: true, kind: true, days: true, effectiveOn: true },
  });

  const byUser = new Map<string, LeaveLedgerEntry[]>();
  for (const r of rows) {
    const entry: LeaveLedgerEntry = {
      kind: r.kind,
      days: r.days,
      effectiveOn: toIsoDate(r.effectiveOn),
    };
    const list = byUser.get(r.userId);
    if (list) list.push(entry);
    else byUser.set(r.userId, [entry]);
  }

  const out: Record<string, ReturnType<typeof projectBalance>> = {};
  for (const id of userIds) out[id] = projectBalance(byUser.get(id) ?? [], undefined, since);
  return out;
}
