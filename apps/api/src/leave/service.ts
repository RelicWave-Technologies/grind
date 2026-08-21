import { prisma, type Prisma } from '@grind/db';
import {
  CreateLeaveRequestSchema,
  roundToHalfDay,
  type CreateLeaveRequest,
  type LeaveQuote,
  type LeaveRequestDto,
} from '@grind/types';
import {
  accrualsDue,
  affordability,
  consumptionSourceKey,
  projectBalance,
  reversalSourceKey,
} from './ledger';
import {
  fromIsoDate,
  loadBalance,
  loadLedgerEntries,
  loadOrCreateLeavePolicy,
  loadWorkingCalendar,
  toIsoDate,
} from './repository';
import { leaveDateRange } from './workingCalendar';
import { leaveDecidedInLark } from './approvalGateway';

/**
 * The leave request lifecycle.
 *
 * The one rule worth stating up front: **a request is priced twice.** Once when
 * it is submitted, so the requester sees what it will cost, and again inside
 * the transaction that approves it. The second pricing is the one that counts,
 * because between the two a holiday can be declared, a shift can change, or
 * another request can be approved against the same balance. Pricing only at
 * submission is how two pending requests both look affordable and together
 * overdraw an account nobody agreed could go negative.
 */

type Tx = Prisma.TransactionClient;

export type LeaveError =
  | 'invalid_range'
  | 'not_found'
  | 'forbidden'
  | 'already_decided'
  | 'insufficient_balance'
  | 'overlapping_request'
  | 'no_working_days'
  | 'no_shift_assigned'
  | 'external_approval'
  | 'applied_in_lark'
  | 'approval_dispatch_failed';

export type LeaveResult<T> = { ok: true; value: T } | { ok: false; error: LeaveError; detail?: string };

/** Longest range a single request may cover, to bound the pricing loop. */
const MAX_LEAVE_DAYS = 90;

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
        leaveAccrualDaysOverride: true,
      },
    }),
    loadOrCreateLeavePolicy(input.workspaceId, db),
  ]);
  if (!user) return 0;

  const joinedOn = toIsoDate(user.joinedOn ?? user.createdAt);
  const due = accrualsDue({
    userId: input.userId,
    joinedOn,
    asOf: input.asOf,
    policy: {
      // The person's own rate wins; the workspace policy is the fallback.
      monthlyAccrualDays: user.leaveAccrualDaysOverride ?? policy.monthlyAccrualDays,
      accrueOnJoinMonth: policy.accrueOnJoinMonth,
      carryForward: policy.carryForward,
      carryForwardCapDays: policy.carryForwardCapDays,
    },
  });
  if (due.length === 0) return 0;

  // skipDuplicates turns "already accrued" into a no-op at the database level,
  // which is the only place it can be enforced against concurrent callers.
  const created = await db.leaveLedgerEntry.createMany({
    data: due.map((d) => ({
      workspaceId: input.workspaceId,
      userId: input.userId,
      kind: 'ACCRUAL' as const,
      days: d.days,
      effectiveOn: fromIsoDate(d.effectiveOn),
      sourceKey: d.sourceKey,
      reason: `Monthly accrual ${d.month}`,
    })),
    skipDuplicates: true,
  });
  return created.count;
}

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

/** Price a prospective request and report it against the current balance. */
export async function quoteLeave(input: {
  workspaceId: string;
  userId: string;
  tz: string;
  body: CreateLeaveRequest;
}): Promise<LeaveResult<LeaveQuote>> {
  const dates = leaveDateRange(input.body.startDate, input.body.endDate, MAX_LEAVE_DAYS + 1);
  if (dates.length === 0 || dates.length > MAX_LEAVE_DAYS) return { ok: false, error: 'invalid_range' };

  const calendar = await loadWorkingCalendar({
    workspaceId: input.workspaceId,
    tz: input.tz,
    userIds: [input.userId],
    from: input.body.startDate,
    to: input.body.endDate,
  });

  const quote = calendar.quote({
    userId: input.userId,
    dates,
    portion: input.body.portion,
    kind: input.body.kind,
  });

  await ensureAccruals({ workspaceId: input.workspaceId, userId: input.userId, asOf: input.body.endDate });
  const [balance, policy] = await Promise.all([
    loadBalance(input.userId),
    loadOrCreateLeavePolicy(input.workspaceId),
  ]);
  const afford = affordability({
    balanceDays: balance.balanceDays,
    chargedDays: quote.chargedDays,
    allowNegativeBalance: policy.allowNegativeBalance,
  });

  return {
    ok: true,
    value: {
      chargedDays: quote.chargedDays,
      balanceDays: balance.balanceDays,
      balanceAfterDays: afford.balanceAfterDays,
      sufficient: afford.sufficient,
      days: quote.days,
    },
  };
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export async function submitLeaveRequest(input: {
  workspaceId: string;
  userId: string;
  tz: string;
  clientUuid: string;
  body: unknown;
}): Promise<LeaveResult<LeaveRequestDto>> {
  // Leave is raised in Lark and mirrored here. Timo cannot originate one: the
  // leave-type control needs an id this tenant exposes nowhere, so a request
  // created here would never reach an approver. Refuse plainly rather than
  // accept something that goes nowhere.
  if (leaveDecidedInLark()) {
    return { ok: false, error: 'applied_in_lark' };
  }

  const parsed = CreateLeaveRequestSchema.safeParse(input.body);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_range', detail: parsed.error.issues[0]?.message };
  }
  const body = parsed.data;

  // A resubmit of the same client uuid returns the original rather than
  // creating a second request — the agent retries on a flaky network.
  const existing = await prisma.leaveRequest.findUnique({
    where: { clientUuid: input.clientUuid },
    include: REQUEST_INCLUDE,
  });
  if (existing) return { ok: true, value: toLeaveRequestDto(existing) };

  const quoted = await quoteLeave({
    workspaceId: input.workspaceId,
    userId: input.userId,
    tz: input.tz,
    body,
  });
  if (!quoted.ok) return quoted;

  const working = quoted.value.days.filter((d) => d.kind === 'PAID_LEAVE' || d.kind === 'UNPAID_LEAVE');
  if (working.length === 0) {
    // Two very different situations look identical from the outside, and only
    // one of them is the person's to fix. No shift assignment means the
    // Working Calendar cannot say anything about ANY date — every day reads
    // NO_SHIFT — so telling them to "pick a working day" would send them round
    // a loop they cannot win. That one is an admin problem, and says so.
    const everyDayUnknown = quoted.value.days.every((d) => d.kind === 'NO_SHIFT');
    return { ok: false, error: everyDayUnknown ? 'no_shift_assigned' : 'no_working_days' };
  }

  const overlapping = await prisma.leaveRequest.findFirst({
    where: {
      userId: input.userId,
      status: { in: ['PENDING', 'APPROVED'] },
      startDate: { lte: fromIsoDate(body.endDate) },
      endDate: { gte: fromIsoDate(body.startDate) },
    },
    select: { id: true },
  });
  if (overlapping) return { ok: false, error: 'overlapping_request' };

  const created = await prisma.leaveRequest.create({
    data: {
      clientUuid: input.clientUuid,
      workspaceId: input.workspaceId,
      userId: input.userId,
      kind: body.kind,
      startDate: fromIsoDate(body.startDate),
      endDate: fromIsoDate(body.endDate),
      portion: body.portion,
      chargedDays: quoted.value.chargedDays,
      reason: body.reason,
    },
    include: REQUEST_INCLUDE,
  });

  return { ok: true, value: toLeaveRequestDto(created) };
}

// ---------------------------------------------------------------------------
// Decision
// ---------------------------------------------------------------------------

/**
 * Approve or reject.
 *
 * `source` distinguishes a decision made inside Timo from one relayed out of
 * Lark. Only the latter is accepted when an external system owns approval —
 * otherwise a request could read APPROVED here while still pending there.
 */
export async function decideLeaveRequest(input: {
  requestId: string;
  decision: 'APPROVE' | 'REJECT';
  deciderId: string | null;
  source: 'DASHBOARD' | 'LARK_APPROVAL';
  note?: string;
  tz: string;
}): Promise<LeaveResult<LeaveRequestDto>> {
  if (input.source === 'DASHBOARD' && leaveDecidedInLark()) {
    return { ok: false, error: 'external_approval' };
  }

  return prisma
    .$transaction(async (tx) => {
      const req = await tx.leaveRequest.findUnique({
        where: { id: input.requestId },
        include: REQUEST_INCLUDE,
      });
      if (!req) return { ok: false, error: 'not_found' } as const;
      if (req.status !== 'PENDING') {
        // Re-approving an already-approved request is a no-op rather than an
        // error: Lark can deliver the same decision twice.
        if (req.status === 'APPROVED' && input.decision === 'APPROVE') {
          return { ok: true, value: toLeaveRequestDto(req) } as const;
        }
        return { ok: false, error: 'already_decided' } as const;
      }

      const startDate = toIsoDate(req.startDate);
      const endDate = toIsoDate(req.endDate);

      if (input.decision === 'REJECT') {
        const updated = await tx.leaveRequest.update({
          where: { id: req.id },
          data: {
            status: 'REJECTED',
            decisionSource: input.source,
            decidedById: input.deciderId,
            decidedAt: new Date(),
            decidedReason: input.note ?? null,
          },
          include: REQUEST_INCLUDE,
        });
        return { ok: true, value: toLeaveRequestDto(updated) } as const;
      }

      // Re-price against the calendar as it stands NOW, not as it stood when
      // the request was written. A holiday declared in between makes the
      // request cheaper; a shift change can make it dearer.
      const calendar = await loadWorkingCalendar({
        workspaceId: req.workspaceId,
        tz: input.tz,
        userIds: [req.userId],
        from: startDate,
        to: endDate,
        db: tx,
      });
      const repriced = calendar.quote({
        userId: req.userId,
        dates: leaveDateRange(startDate, endDate, MAX_LEAVE_DAYS + 1),
        portion: req.portion,
        kind: req.kind,
      });

      await ensureAccruals({ workspaceId: req.workspaceId, userId: req.userId, asOf: endDate, db: tx });
      const [entries, policy] = await Promise.all([
        loadLedgerEntries(req.userId, tx),
        loadOrCreateLeavePolicy(req.workspaceId, tx),
      ]);
      const balance = projectBalance(entries);
      const afford = affordability({
        balanceDays: balance.balanceDays,
        chargedDays: repriced.chargedDays,
        allowNegativeBalance: policy.allowNegativeBalance,
      });
      if (!afford.sufficient) {
        return {
          ok: false,
          error: 'insufficient_balance',
          detail: `short by ${afford.shortfallDays} day(s)`,
        } as const;
      }

      const updated = await tx.leaveRequest.update({
        where: { id: req.id },
        data: {
          status: 'APPROVED',
          chargedDays: repriced.chargedDays,
          decisionSource: input.source,
          decidedById: input.deciderId,
          decidedAt: new Date(),
          decidedReason: input.note ?? null,
        },
        include: REQUEST_INCLUDE,
      });

      // Only a PAID request draws the balance down. The unique sourceKey is
      // what makes a replayed approval harmless.
      if (repriced.chargedDays > 0) {
        await tx.leaveLedgerEntry.createMany({
          data: [
            {
              workspaceId: req.workspaceId,
              userId: req.userId,
              kind: 'CONSUMPTION' as const,
              days: -repriced.chargedDays,
              effectiveOn: fromIsoDate(startDate),
              sourceKey: consumptionSourceKey(req.id),
              reason: `Leave ${startDate}${endDate === startDate ? '' : ` to ${endDate}`}`,
              requestId: req.id,
            },
          ],
          skipDuplicates: true,
        });
      }

      return { ok: true, value: toLeaveRequestDto(updated) } as const;
    })
    .then((r) => r as LeaveResult<LeaveRequestDto>);
}

/**
 * Cancel a request. An approved one is given back with a reversing entry
 * rather than by deleting the charge, so the statement still explains itself.
 */
export async function cancelLeaveRequest(input: {
  requestId: string;
  actorId: string;
  isSelf: boolean;
}): Promise<LeaveResult<LeaveRequestDto>> {
  return prisma
    .$transaction(async (tx) => {
      const req = await tx.leaveRequest.findUnique({
        where: { id: input.requestId },
        include: REQUEST_INCLUDE,
      });
      if (!req) return { ok: false, error: 'not_found' } as const;
      if (req.status === 'CANCELLED') return { ok: true, value: toLeaveRequestDto(req) } as const;
      if (req.status === 'REJECTED') return { ok: false, error: 'already_decided' } as const;

      const updated = await tx.leaveRequest.update({
        where: { id: req.id },
        data: {
          status: 'CANCELLED',
          decisionSource: 'REQUESTER_CANCEL',
          decidedById: input.actorId,
          decidedAt: new Date(),
        },
        include: REQUEST_INCLUDE,
      });

      if (req.status === 'APPROVED' && req.chargedDays > 0) {
        await tx.leaveLedgerEntry.createMany({
          data: [
            {
              workspaceId: req.workspaceId,
              userId: req.userId,
              kind: 'ADJUSTMENT' as const,
              days: req.chargedDays,
              effectiveOn: fromIsoDate(toIsoDate(req.startDate)),
              sourceKey: reversalSourceKey(req.id),
              reason: 'Leave cancelled',
              requestId: req.id,
              createdById: input.actorId,
            },
          ],
          skipDuplicates: true,
        });
      }

      return { ok: true, value: toLeaveRequestDto(updated) } as const;
    })
    .then((r) => r as LeaveResult<LeaveRequestDto>);
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
