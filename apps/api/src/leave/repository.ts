import { prisma, type Prisma } from '@grind/db';
import { LEAVE_POLICY_DEFAULTS, type LeavePolicyDto } from '@grind/types';
import { WorkingCalendar, type ShiftAssignmentInput } from './workingCalendar';
import { projectBalance, type LeaveLedgerEntry } from './ledger';

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
  updatedAt: Date;
}): LeavePolicyDto {
  return {
    monthlyAccrualDays: row.monthlyAccrualDays,
    carryForward: row.carryForward,
    carryForwardCapDays: row.carryForwardCapDays,
    allowNegativeBalance: row.allowNegativeBalance,
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
  const fromDate = fromIsoDate(input.from);
  const toDate = fromIsoDate(input.to);

  const [policy, users, assignments, holidays, leave] = await Promise.all([
    loadOrCreateLeavePolicy(input.workspaceId, db),
    db.user.findMany({
      where: { id: { in: input.userIds } },
      select: { id: true, teamId: true, lastSaturdayOffOverride: true },
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

  return new WorkingCalendar({
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
  });
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

/** Balance for one person as of a date. */
export async function loadBalance(
  userId: string,
  asOf?: string,
  db: Tx | typeof prisma = prisma,
) {
  return projectBalance(await loadLedgerEntries(userId, db), asOf);
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
  for (const id of userIds) out[id] = projectBalance(byUser.get(id) ?? []);
  return out;
}
