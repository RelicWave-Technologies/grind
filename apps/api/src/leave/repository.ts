import { prisma, type Prisma } from '@grind/db';
import { LEAVE_POLICY_DEFAULTS, type LeavePolicyDto } from '@grind/types';
import { WorkingCalendar, type ShiftAssignmentInput } from './workingCalendar';
import { projectBalance, type LeaveLedgerEntry } from './ledger';
import { resolveUnfundedLeaveDays, type ChargeableLeaveDay, type LeaveCredit } from './leaveFunding';

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

/** A `Date` from a Postgres `date` column, as YYYY-MM-DD. */
export function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
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
  const loadFrom = fundingFloor && fundingFloor < input.from ? fundingFloor : input.from;

  const fromDate = fromIsoDate(loadFrom);
  const toDate = fromIsoDate(input.to);

  const [users, assignments, holidays, leave, credits] = await Promise.all([
    db.user.findMany({
      where: { id: { in: input.userIds } },
      select: {
        id: true,
        teamId: true,
        lastSaturdayOffOverride: true,
        joinedOn: true,
        createdAt: true,
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
      },
      select: { userId: true, effectiveOn: true, days: true },
    }),
  ]);

  const userTeamIds: Record<string, string | null> = {};
  const lastSaturdayOffFor: Record<string, boolean> = {};
  for (const u of users) {
    userTeamIds[u.id] = u.teamId;
    // The person's own answer wins; the workspace policy is the fallback.
    lastSaturdayOffFor[u.id] = u.lastSaturdayOffOverride ?? policy.lastSaturdayOff;
  }

  const shiftAssignments: Record<string, ShiftAssignmentInput[]> = {};
  for (const a of assignments) {
    (shiftAssignments[a.userId] ??= []).push({
      shiftId: a.shiftId,
      effectiveFrom: a.effectiveFrom,
      effectiveTo: a.effectiveTo,
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
  for (const u of users) accrualStartFor[u.id] = toIsoDate(u.joinedOn ?? u.createdAt);

  const leaveDays: ChargeableLeaveDay[] = [];
  for (const l of shared.approvedLeave) {
    if (l.kind !== 'PAID') continue;
    for (const date of datesBetween(l.startDate, l.endDate)) {
      if (date > input.to) break;
      const status = priced.dayStatus(l.userId, date);
      leaveDays.push({ userId: l.userId, date, cost: status.chargedDays });
    }
  }

  const creditRows: LeaveCredit[] = credits.map((c) => ({
    userId: c.userId,
    effectiveOn: toIsoDate(c.effectiveOn),
    days: c.days,
  }));

  return new WorkingCalendar({
    ...shared,
    unfundedLeaveDays: resolveUnfundedLeaveDays({
      credits: creditRows,
      leaveDays,
      since: fundingFloor,
      accrualStartFor,
    }),
  });
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
