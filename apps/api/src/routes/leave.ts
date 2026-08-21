import { Router } from 'express';
import { prisma } from '@grind/db';
import {
  CreateHolidaySchema,
  CreateLeaveRequestSchema,
  DecideLeaveRequestSchema,
  PatchHolidaySchema,
  PatchLeavePolicySchema,
  SignedLeaveDaysSchema,
  leaveDaysSchema,
  type HolidayDto,
  type LeaveBalanceDto,
} from '@grind/types';
import { z } from 'zod';
import { requireAccessToken } from '../middleware/auth';
import { attachScope, requireAdmin } from '../middleware/scope';
import {
  cancelLeaveRequest,
  decideLeaveRequest,
  ensureAccruals,
  leaveDecidedInLark,
  leaveDateRange,
  loadBalance,
  loadBalances,
  loadLedgerEntries,
  loadOrCreateLeavePolicy,
  loadWorkingCalendar,
  quoteLeave,
  submitLeaveRequest,
  toLeavePolicyDto,
  toIsoDate,
  fromIsoDate,
  REQUEST_INCLUDE,
  toLeaveRequestDto,
} from '../leave';

/**
 * Leave, company holidays and balances.
 *
 * Mounted at /v1/leave (self-service) and /v1/admin/leave (administration).
 * The split mirrors the rest of the API: a member may act on themselves, an
 * admin may act on the workspace.
 */

export const leaveRouter = Router();
leaveRouter.use(requireAccessToken, attachScope);

const RangeQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
});

/** Longest window any calendar query may span. */
const MAX_RANGE_DAYS = 120;

function today(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
}

// ---------------------------------------------------------------------------
// Self-service
// ---------------------------------------------------------------------------

/** My balance, with the statement behind it. */
leaveRouter.get('/me/balance', async (req, res, next) => {
  try {
    if (!req.user || !req.scope) return res.status(401).json({ error: 'unauthorized' });
    const asOf = today(req.scope.workspaceTimezone);
    await ensureAccruals({ workspaceId: req.scope.workspaceId, userId: req.user.sub, asOf });
    const [balance, entries] = await Promise.all([
      loadBalance(req.user.sub, asOf),
      loadLedgerEntries(req.user.sub),
    ]);
    const dto: LeaveBalanceDto = { userId: req.user.sub, asOf, ...balance };
    res.json({
      balance: dto,
      // The statement IS the answer to "why is my balance 1.5?".
      statement: entries.map((e) => ({
        kind: e.kind,
        days: e.days,
        effectiveOn: e.effectiveOn,
        reason: e.reason ?? null,
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** My requests, newest first. */
leaveRouter.get('/me/requests', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const rows = await prisma.leaveRequest.findMany({
      where: { userId: req.user.sub },
      include: REQUEST_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    res.json({ requests: rows.map(toLeaveRequestDto) });
  } catch (err) {
    next(err);
  }
});

/** Price a prospective request before submitting it. */
leaveRouter.post('/quote', async (req, res, next) => {
  try {
    if (!req.user || !req.scope) return res.status(401).json({ error: 'unauthorized' });
    const parsed = CreateLeaveRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_body', detail: parsed.error.issues[0]?.message });
    }
    const result = await quoteLeave({
      workspaceId: req.scope.workspaceId,
      userId: req.user.sub,
      tz: req.scope.workspaceTimezone,
      body: parsed.data,
    });
    if (!result.ok) return res.status(400).json({ error: result.error, detail: result.detail });
    res.json(result.value);
  } catch (err) {
    next(err);
  }
});

/** Submit a request. */
leaveRouter.post('/requests', async (req, res, next) => {
  try {
    if (!req.user || !req.scope) return res.status(401).json({ error: 'unauthorized' });
    const clientUuid = typeof req.body?.clientUuid === 'string' && req.body.clientUuid.trim()
      ? req.body.clientUuid.trim()
      : crypto.randomUUID();

    const result = await submitLeaveRequest({
      workspaceId: req.scope.workspaceId,
      userId: req.user.sub,
      tz: req.scope.workspaceTimezone,
      clientUuid,
      body: req.body,
    });
    if (!result.ok) {
      const status = result.error === 'approval_dispatch_failed' ? 502 : 400;
      return res.status(status).json({ error: result.error, detail: result.detail });
    }
    res.status(201).json(result.value);
  } catch (err) {
    next(err);
  }
});

/** Cancel my own request. */
leaveRouter.post('/requests/:id/cancel', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const existing = await prisma.leaveRequest.findUnique({
      where: { id: req.params.id },
      select: { userId: true },
    });
    if (!existing) return res.status(404).json({ error: 'not_found' });
    if (existing.userId !== req.user.sub) return res.status(403).json({ error: 'forbidden' });

    const result = await cancelLeaveRequest({
      requestId: req.params.id,
      actorId: req.user.sub,
      isSelf: true,
    });
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json(result.value);
  } catch (err) {
    next(err);
  }
});

/**
 * Who is away across a range, for everyone in scope. Powers the calendar
 * screen's "who is on leave today" and the day-cell markers.
 */
leaveRouter.get('/calendar', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const parsed = RangeQuery.safeParse(req.query);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_range' });
    const dates = leaveDateRange(parsed.data.from, parsed.data.to, MAX_RANGE_DAYS + 1);
    if (dates.length === 0 || dates.length > MAX_RANGE_DAYS) {
      return res.status(400).json({ error: 'range_too_long', maxDays: MAX_RANGE_DAYS });
    }

    const [calendar, users, holidays] = await Promise.all([
      loadWorkingCalendar({
        workspaceId: req.scope.workspaceId,
        tz: req.scope.workspaceTimezone,
        userIds: req.scope.userIds,
        from: parsed.data.from,
        to: parsed.data.to,
      }),
      prisma.user.findMany({
        where: { id: { in: req.scope.userIds }, deactivatedAt: null },
        select: { id: true, name: true, avatarUrl: true, teamId: true },
        orderBy: { name: 'asc' },
      }),
      prisma.companyHoliday.findMany({
        where: {
          workspaceId: req.scope.workspaceId,
          date: { gte: fromIsoDate(parsed.data.from), lte: fromIsoDate(parsed.data.to) },
        },
        include: { team: { select: { name: true } } },
        orderBy: { date: 'asc' },
      }),
    ]);

    // Only the days that are NOT ordinary working days are worth sending — the
    // calendar screen renders absence, and a full matrix of "WORKING" would be
    // mostly noise on the wire.
    const away: Record<string, Array<{ date: string; kind: string; portion: string | null; label: string | null }>> = {};
    for (const u of users) {
      const rows = calendar
        .dayStatuses(u.id, dates)
        .filter((d) => d.kind === 'PAID_LEAVE' || d.kind === 'UNPAID_LEAVE')
        .map((d) => ({ date: d.date, kind: d.kind, portion: d.portion, label: d.label }));
      if (rows.length) away[u.id] = rows;
    }

    res.json({
      from: parsed.data.from,
      to: parsed.data.to,
      tz: req.scope.workspaceTimezone,
      users,
      away,
      holidays: holidays.map(toHolidayDto),
    });
  } catch (err) {
    next(err);
  }
});

/** The policy is readable by everyone — the agent shows "1 day / month". */
leaveRouter.get('/policy', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const policy = await loadOrCreateLeavePolicy(req.scope.workspaceId);
    res.json({
      policy: toLeavePolicyDto(policy),
      approvalGateway: leaveDecidedInLark() ? 'lark' : 'dashboard',
      decidesInTimo: !leaveDecidedInLark(),
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// Administration
// ---------------------------------------------------------------------------

export const adminLeaveRouter = Router();
adminLeaveRouter.use(requireAccessToken, attachScope);

function toHolidayDto(row: {
  id: string;
  date: Date;
  name: string;
  teamId: string | null;
  team?: { name: string } | null;
  createdAt: Date;
}): HolidayDto {
  return {
    id: row.id,
    date: toIsoDate(row.date),
    name: row.name,
    teamId: row.teamId,
    teamName: row.team?.name ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

adminLeaveRouter.get('/holidays', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const year = typeof req.query.year === 'string' ? req.query.year : null;
    const where = year && /^\d{4}$/u.test(year)
      ? {
          workspaceId: req.scope.workspaceId,
          date: { gte: fromIsoDate(`${year}-01-01`), lte: fromIsoDate(`${year}-12-31`) },
        }
      : { workspaceId: req.scope.workspaceId };
    const rows = await prisma.companyHoliday.findMany({
      where,
      include: { team: { select: { name: true } } },
      orderBy: { date: 'asc' },
    });
    res.json({ holidays: rows.map(toHolidayDto) });
  } catch (err) {
    next(err);
  }
});

adminLeaveRouter.post('/holidays', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const parsed = CreateHolidaySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_body', detail: parsed.error.issues[0]?.message });
    }
    const teamId = parsed.data.teamId ?? null;
    // Postgres treats NULLs as distinct in a unique index, so a workspace-wide
    // duplicate would slip past the constraint. Reject it here instead.
    const clash = await prisma.companyHoliday.findFirst({
      where: { workspaceId: req.scope.workspaceId, date: fromIsoDate(parsed.data.date), teamId },
      select: { id: true },
    });
    if (clash) return res.status(409).json({ error: 'holiday_exists' });

    const row = await prisma.companyHoliday.create({
      data: {
        workspaceId: req.scope.workspaceId,
        date: fromIsoDate(parsed.data.date),
        name: parsed.data.name,
        teamId,
        createdById: req.user?.sub ?? null,
      },
      include: { team: { select: { name: true } } },
    });
    res.status(201).json(toHolidayDto(row));
  } catch (err) {
    next(err);
  }
});

adminLeaveRouter.patch('/holidays/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const parsed = PatchHolidaySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_body', detail: parsed.error.issues[0]?.message });
    }
    const existing = await prisma.companyHoliday.findFirst({
      where: { id: req.params.id, workspaceId: req.scope.workspaceId },
      select: { id: true },
    });
    if (!existing) return res.status(404).json({ error: 'not_found' });

    const row = await prisma.companyHoliday.update({
      where: { id: req.params.id },
      data: {
        ...(parsed.data.date ? { date: fromIsoDate(parsed.data.date) } : {}),
        ...(parsed.data.name ? { name: parsed.data.name } : {}),
        ...(parsed.data.teamId !== undefined ? { teamId: parsed.data.teamId } : {}),
      },
      include: { team: { select: { name: true } } },
    });
    res.json(toHolidayDto(row));
  } catch (err) {
    next(err);
  }
});

adminLeaveRouter.delete('/holidays/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const deleted = await prisma.companyHoliday.deleteMany({
      where: { id: req.params.id, workspaceId: req.scope.workspaceId },
    });
    if (deleted.count === 0) return res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

adminLeaveRouter.get('/policy', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const policy = await loadOrCreateLeavePolicy(req.scope.workspaceId);
    res.json(toLeavePolicyDto(policy));
  } catch (err) {
    next(err);
  }
});

adminLeaveRouter.patch('/policy', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const parsed = PatchLeavePolicySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_body', detail: parsed.error.issues[0]?.message });
    }
    await loadOrCreateLeavePolicy(req.scope.workspaceId);
    const updated = await prisma.leavePolicy.update({
      where: { workspaceId: req.scope.workspaceId },
      data: parsed.data,
    });
    res.json(toLeavePolicyDto(updated));
  } catch (err) {
    next(err);
  }
});

adminLeaveRouter.get('/requests', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : null;
    const rows = await prisma.leaveRequest.findMany({
      where: {
        workspaceId: req.scope.workspaceId,
        userId: { in: req.scope.userIds },
        ...(status && ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].includes(status)
          ? { status: status as 'PENDING' }
          : {}),
      },
      include: REQUEST_INCLUDE,
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    res.json({ requests: rows.map(toLeaveRequestDto) });
  } catch (err) {
    next(err);
  }
});

/**
 * Decide a request from inside Timo. Refused when Lark owns approval — a
 * request must not read APPROVED here while it is still sitting in somebody's
 * Lark inbox.
 */
adminLeaveRouter.post('/requests/:id/decide', async (req, res, next) => {
  try {
    if (!req.user || !req.scope) return res.status(401).json({ error: 'unauthorized' });
    const parsed = DecideLeaveRequestSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body' });

    const target = await prisma.leaveRequest.findFirst({
      where: { id: req.params.id, workspaceId: req.scope.workspaceId },
      select: { userId: true },
    });
    if (!target) return res.status(404).json({ error: 'not_found' });
    if (!req.scope.userIds.includes(target.userId)) return res.status(403).json({ error: 'forbidden' });
    if (target.userId === req.user.sub && !req.scope.isAdmin) {
      return res.status(403).json({ error: 'self_approval_forbidden' });
    }

    const result = await decideLeaveRequest({
      requestId: req.params.id,
      decision: parsed.data.decision,
      deciderId: req.user.sub,
      source: 'DASHBOARD',
      note: parsed.data.note,
      tz: req.scope.workspaceTimezone,
    });
    if (!result.ok) {
      const status = result.error === 'external_approval' ? 409 : 400;
      return res.status(status).json({ error: result.error, detail: result.detail });
    }
    res.json(result.value);
  } catch (err) {
    next(err);
  }
});

/**
 * Balances for everyone in scope, with enough to render and edit a row.
 *
 * One query for the people and one for the ledger, rather than a balance call
 * per person: this is the admin's whole-company view and a hundred round trips
 * would make it feel broken.
 */
adminLeaveRouter.get('/balances', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const asOf = typeof req.query.asOf === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(req.query.asOf)
      ? req.query.asOf
      : today(req.scope.workspaceTimezone);

    for (const userId of req.scope.userIds) {
      await ensureAccruals({ workspaceId: req.scope.workspaceId, userId, asOf });
    }

    const [people, balances, policy] = await Promise.all([
      prisma.user.findMany({
        where: { id: { in: req.scope.userIds }, deactivatedAt: null },
        select: {
          id: true, name: true, email: true, avatarUrl: true,
          joinedOn: true, createdAt: true,
          leaveAccrualDaysOverride: true,
          lastSaturdayOffOverride: true,
          team: { select: { name: true } },
        },
        orderBy: { name: 'asc' },
      }),
      loadBalances(req.scope.userIds, asOf),
      loadOrCreateLeavePolicy(req.scope.workspaceId),
    ]);

    res.json({
      asOf,
      policy: toLeavePolicyDto(policy),
      rows: people.map((p) => ({
        userId: p.id,
        name: p.name,
        email: p.email,
        avatarUrl: p.avatarUrl,
        teamName: p.team?.name ?? null,
        // Null means "inherits the workspace policy" — the UI says so rather
        // than showing the resolved number as if somebody had chosen it.
        accrualDays: p.leaveAccrualDaysOverride,
        effectiveAccrualDays: p.leaveAccrualDaysOverride ?? policy.monthlyAccrualDays,
        lastSaturdayOff: p.lastSaturdayOffOverride,
        effectiveLastSaturdayOff: p.lastSaturdayOffOverride ?? policy.lastSaturdayOff,
        accrualStart: toIsoDate(p.joinedOn ?? p.createdAt),
        joinedOnSet: p.joinedOn !== null,
        ...(balances[p.id] ?? { balanceDays: 0, accruedDays: 0, consumedDays: 0, adjustedDays: 0 }),
      })),
    });
  } catch (err) {
    next(err);
  }
});

const PatchMemberLeaveSchema = z
  .object({
    accrualDays: leaveDaysSchema(31).nullable().optional(),
    lastSaturdayOff: z.boolean().nullable().optional(),
    joinedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing_to_update' });

/**
 * Edit one person's leave settings.
 *
 * Deliberately not the balance itself: a balance is the sum of a ledger, and
 * setting it directly would be the counter this design exists to avoid. To move
 * a number, post an adjustment — it carries a reason and shows in the statement.
 */
adminLeaveRouter.patch('/members/:userId', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const parsed = PatchMemberLeaveSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_body', detail: parsed.error.issues[0]?.message });
    }
    const userId = req.params.userId;
    if (!userId || !req.scope.userIds.includes(userId)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const data: Record<string, unknown> = {};
    if (parsed.data.accrualDays !== undefined) data.leaveAccrualDaysOverride = parsed.data.accrualDays;
    if (parsed.data.lastSaturdayOff !== undefined) data.lastSaturdayOffOverride = parsed.data.lastSaturdayOff;
    if (parsed.data.joinedOn !== undefined) {
      data.joinedOn = parsed.data.joinedOn ? fromIsoDate(parsed.data.joinedOn) : null;
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data,
      select: {
        id: true, joinedOn: true, createdAt: true,
        leaveAccrualDaysOverride: true, lastSaturdayOffOverride: true,
      },
    });

    // Changing the anchor or the rate can make months newly due; write them now
    // so the row the admin sees next reflects the change immediately.
    await ensureAccruals({
      workspaceId: req.scope.workspaceId,
      userId: updated.id,
      asOf: today(req.scope.workspaceTimezone),
    });

    res.json({
      userId: updated.id,
      accrualDays: updated.leaveAccrualDaysOverride,
      lastSaturdayOff: updated.lastSaturdayOffOverride,
      accrualStart: toIsoDate(updated.joinedOn ?? updated.createdAt),
      balance: await loadBalance(updated.id),
    });
  } catch (err) {
    next(err);
  }
});

const AdjustSchema = z.object({
  userId: z.string().min(1),
  days: SignedLeaveDaysSchema,
  effectiveOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  reason: z.string().trim().min(1).max(300),
});

/**
 * An admin correction. Written as a ledger entry with a reason rather than by
 * setting a balance, so the statement still explains how the number got there.
 */
adminLeaveRouter.post('/adjust', requireAdmin, async (req, res, next) => {
  try {
    if (!req.user || !req.scope) return res.status(401).json({ error: 'unauthorized' });
    const parsed = AdjustSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_body', detail: parsed.error.issues[0]?.message });
    }
    if (!req.scope.userIds.includes(parsed.data.userId)) {
      return res.status(403).json({ error: 'forbidden' });
    }

    const entry = await prisma.leaveLedgerEntry.create({
      data: {
        workspaceId: req.scope.workspaceId,
        userId: parsed.data.userId,
        kind: 'ADJUSTMENT',
        days: parsed.data.days,
        effectiveOn: fromIsoDate(parsed.data.effectiveOn),
        // A unique key per adjustment; admins may legitimately make several.
        sourceKey: `adjust:${crypto.randomUUID()}`,
        reason: parsed.data.reason,
        createdById: req.user.sub,
      },
    });
    const balance = await loadBalance(parsed.data.userId);
    res.status(201).json({ entryId: entry.id, balance });
  } catch (err) {
    next(err);
  }
});
