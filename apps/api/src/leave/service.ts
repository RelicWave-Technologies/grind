import { prisma, type Prisma } from '@grind/db';
import { roundToHalfDay, type LeaveRequestDto } from '@grind/types';
import { accrualsDue, birthdayAccrualsDue } from './ledger';
import { accrualStartDate, fromIsoDate, loadOrCreateLeavePolicy, toIsoDate } from './repository';

/**
 * Leave accrual and request serialisation.
 *
 * Requests themselves are applied and decided in Lark and mirrored in by
 * larkIngest; this module only keeps the ledger's accruals current and turns
 * stored requests into DTOs.
 */

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Accrual
// ---------------------------------------------------------------------------

/**
 * Materialise every accrual entry this person is owed up to `asOf`.
 *
 * Derived rather than fired: we compute the full set from the join date and
 * write the ones that are missing. A month the scheduler skipped is simply
 * written the next time anyone asks, correctly dated, and a month already
 * present collides on `sourceKey` and is skipped. That is why this can be
 * called on every balance read without fear.
 */
export async function ensureAccruals(input: {
  workspaceId: string;
  userId: string;
  asOf: string;
  db?: Tx | typeof prisma;
}): Promise<number> {
  const db = input.db ?? prisma;
  const [user, policy] = await Promise.all([
    db.user.findUnique({
      where: { id: input.userId },
      select: {
        id: true, joinedOn: true, createdAt: true, deactivatedAt: true,
        leaveAccrualDaysOverride: true, birthDate: true,
        workspace: { select: { timezone: true } },
      },
    }),
    loadOrCreateLeavePolicy(input.workspaceId, db),
  ]);
  if (!user) return 0;

  const joinedOn = accrualStartDate(user, user.workspace.timezone);
  const due = accrualsDue({
    userId: input.userId,
    joinedOn,
    asOf: input.asOf,
    policy: {
      // The person's own rate wins; the workspace policy is the fallback.
      monthlyAccrualDays: user.leaveAccrualDaysOverride ?? policy.monthlyAccrualDays,
      accrueOnJoinMonth: policy.accrueOnJoinMonth,
      ledgerStartMonth: policy.ledgerStartMonth,
      carryForward: policy.carryForward,
      carryForwardCapDays: policy.carryForwardCapDays,
    },
  });

  const birthdays = birthdayAccrualsDue({
    userId: input.userId,
    birthDate: user.birthDate ? toIsoDate(user.birthDate) : null,
    joinedOn,
    asOf: input.asOf,
    days: policy.birthdayLeaveDays,
    ledgerStartMonth: policy.ledgerStartMonth,
  });

  if (due.length === 0 && birthdays.length === 0) return 0;

  // skipDuplicates turns "already accrued" into a no-op at the database level,
  // which is the only place it can be enforced against concurrent callers.
  // Both kinds carry their own source key, so the two never collide.
  const created = await db.leaveLedgerEntry.createMany({
    data: [
      ...due.map((d) => ({
        workspaceId: input.workspaceId,
        userId: input.userId,
        kind: 'ACCRUAL' as const,
        days: d.days,
        effectiveOn: fromIsoDate(d.effectiveOn),
        sourceKey: d.sourceKey,
        reason: `Monthly accrual ${d.month}`,
      })),
      ...birthdays.map((d) => ({
        workspaceId: input.workspaceId,
        userId: input.userId,
        kind: 'ACCRUAL' as const,
        days: d.days,
        effectiveOn: fromIsoDate(d.effectiveOn),
        sourceKey: d.sourceKey,
        reason: `Birthday ${d.effectiveOn}`,
      })),
    ],
    skipDuplicates: true,
  });
  return created.count;
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

export const REQUEST_INCLUDE = {
  user: { select: { name: true, larkIdentity: { select: { openId: true } } } },
  decidedBy: { select: { name: true } },
} satisfies Prisma.LeaveRequestInclude;

type LeaveRequestRow = Prisma.LeaveRequestGetPayload<{ include: typeof REQUEST_INCLUDE }>;

export function toLeaveRequestDto(row: LeaveRequestRow): LeaveRequestDto {
  return {
    id: row.id,
    userId: row.userId,
    userName: row.user.name,
    kind: row.kind,
    startDate: toIsoDate(row.startDate),
    endDate: toIsoDate(row.endDate),
    portion: row.portion,
    chargedDays: roundToHalfDay(row.chargedDays),
    reason: row.reason,
    status: row.status,
    decisionSource: row.decisionSource,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decidedByName: row.decidedBy?.name ?? null,
    larkInstanceCode: row.larkInstanceCode,
    createdAt: row.createdAt.toISOString(),
  };
}
