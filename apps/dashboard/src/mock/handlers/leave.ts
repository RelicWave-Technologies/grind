/** /v1/leave/* and /v1/admin/leave/* — calendar, balances, holidays, ledger. */
import { roundToHalfDay } from '@grind/types';
import type {
  HolidayDto,
  LeaveAwayDay,
  LeaveBalanceResponse,
  LeaveBalanceRow,
  LeaveBalancesResponse,
  LeaveCalendarResponse,
  LeavePolicyResponse,
  LeaveRequestDto,
  LeaveStatementRow,
} from '../../lib/types';
import { addDays, dateKeyOf, iso, isValidDateKey, monthBounds, shiftMonth, todayKey, TZ } from '../clock';
import { persist, type DbHoliday, type DbLeaveRequest, type DbUser } from '../db';
import { isTracked, scopeUsers, teamNameOf, userById } from '../derive';
import { bodyObject, del, fail, get, patch, post, str, withStatus, type Ctx } from '../http';
import { newId, rngFor } from '../rng';
import { requireAdmin, requireUser } from './common';

function holidayDto(ctx: Ctx, h: DbHoliday): HolidayDto {
  return { id: h.id, date: h.date, name: h.name, teamId: h.teamId, teamName: teamNameOf(ctx, h.teamId), createdAt: iso(h.createdAt) };
}

function leaveDto(ctx: Ctx, r: DbLeaveRequest): LeaveRequestDto {
  return {
    id: r.id,
    userId: r.userId,
    userName: userById(ctx, r.userId)?.name ?? 'Former member',
    kind: r.kind,
    startDate: r.startDate,
    endDate: r.endDate,
    portion: r.portion,
    chargedDays: r.chargedDays,
    reason: r.reason,
    status: r.status,
    decisionSource: r.decisionSource,
    decidedAt: r.decidedAt === null ? null : iso(r.decidedAt),
    decidedByName: r.decidedById ? userById(ctx, r.decidedById)?.name ?? null : null,
    larkInstanceCode: r.larkInstanceCode,
    createdAt: iso(r.createdAt),
  };
}

function monthLabel(month: string): string {
  const [y, m] = month.split('-').map((n) => Number.parseInt(n, 10));
  return new Date(Date.UTC(y!, m! - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function accrualStart(u: DbUser): string {
  return u.joinedOn ?? dateKeyOf(u.createdAt);
}

/** The ledger a balance is summed from, newest first. */
function ledger(ctx: Ctx, u: DbUser, asOf: string): { rows: LeaveStatementRow[]; accrued: number; consumed: number; adjusted: number } {
  const policy = ctx.db.leavePolicy;
  const rate = u.leaveAccrualDays ?? policy.monthlyAccrualDays;
  const rows: LeaveStatementRow[] = [];
  let accrued = 0;
  let consumed = 0;
  let adjusted = 0;
  const yearStart = `${asOf.slice(0, 4)}-01-01`;
  const start = accrualStart(u);
  if (start < yearStart && policy.carryForward) {
    const carried = Math.min(policy.carryForwardCapDays ?? 99, roundToHalfDay(rngFor('carry', u.id).range(2, 9)));
    rows.push({ kind: 'ADJUSTMENT', days: carried, effectiveOn: yearStart, reason: `Carried forward from ${Number(asOf.slice(0, 4)) - 1}` });
    adjusted += carried;
  }
  let month = (start > yearStart ? start : yearStart).slice(0, 7);
  if (!policy.accrueOnJoinMonth && start > yearStart) month = shiftMonth(month, 1);
  while (`${month}-01` <= asOf) {
    const on = month === start.slice(0, 7) && start > `${month}-01` ? start : `${month}-01`;
    rows.push({ kind: 'ACCRUAL', days: rate, effectiveOn: on, reason: `Monthly accrual — ${monthLabel(month)}` });
    accrued += rate;
    month = shiftMonth(month, 1);
  }
  for (const r of ctx.db.leaveRequests) {
    if (r.userId !== u.id || r.status !== 'APPROVED' || r.kind !== 'PAID' || r.startDate > asOf || r.chargedDays === 0) continue;
    rows.push({ kind: 'CONSUMPTION', days: -r.chargedDays, effectiveOn: r.startDate, reason: r.portion === 'FULL' ? `Casual Leave · ${r.reason}` : `Half day · ${r.reason}` });
    consumed += r.chargedDays;
  }
  for (const a of ctx.db.leaveAdjustments) {
    if (a.userId !== u.id || a.effectiveOn > asOf) continue;
    rows.push({ kind: 'ADJUSTMENT', days: a.days, effectiveOn: a.effectiveOn, reason: a.reason });
    adjusted += a.days;
  }
  rows.sort((x, y) => (x.effectiveOn < y.effectiveOn ? 1 : x.effectiveOn > y.effectiveOn ? -1 : 0));
  return { rows, accrued: roundToHalfDay(accrued), consumed: roundToHalfDay(consumed), adjusted: roundToHalfDay(adjusted) };
}

function balanceRow(ctx: Ctx, u: DbUser, asOf: string): LeaveBalanceRow {
  const l = ledger(ctx, u, asOf);
  const policy = ctx.db.leavePolicy;
  return {
    userId: u.id,
    name: u.name,
    email: u.email,
    avatarUrl: u.avatarUrl,
    teamName: teamNameOf(ctx, u.teamId),
    accrualDays: u.leaveAccrualDays,
    effectiveAccrualDays: u.leaveAccrualDays ?? policy.monthlyAccrualDays,
    lastSaturdayOff: u.leaveLastSaturdayOff,
    effectiveLastSaturdayOff: u.leaveLastSaturdayOff ?? false,
    accrualStart: accrualStart(u),
    joinedOnSet: u.joinedOn !== null,
    balanceDays: roundToHalfDay(l.accrued - l.consumed + l.adjusted),
    accruedDays: l.accrued,
    consumedDays: l.consumed,
    adjustedDays: l.adjusted,
  };
}

function policyDto(ctx: Ctx): LeavePolicyResponse['policy'] {
  const p = ctx.db.leavePolicy;
  return {
    monthlyAccrualDays: p.monthlyAccrualDays,
    carryForward: p.carryForward,
    carryForwardCapDays: p.carryForwardCapDays,
    allowNegativeBalance: p.allowNegativeBalance,
    accrueOnJoinMonth: p.accrueOnJoinMonth,
    updatedAt: iso(p.updatedAt),
  };
}

export function registerLeave(): void {
  get('/v1/leave/calendar', (req, ctx): LeaveCalendarResponse => {
    const today = todayKey();
    const fallback = monthBounds(today.slice(0, 7));
    const from = req.query.get('from') ?? fallback.from;
    const to = req.query.get('to') ?? fallback.to;
    if (!isValidDateKey(from) || !isValidDateKey(to) || from > to) fail(400, 'invalid_range');
    const users = scopeUsers(ctx).filter(isTracked);
    const away: Record<string, LeaveAwayDay[]> = {};
    if (!ctx.empty) {
      for (const u of users) {
        for (const r of ctx.db.leaveRequests) {
          if (r.userId !== u.id || r.status !== 'APPROVED' || r.endDate < from || r.startDate > to) continue;
          for (let d = r.startDate > from ? r.startDate : from; d <= r.endDate && d <= to; d = addDays(d, 1)) {
            const w = new Date(`${d}T12:00:00Z`).getUTCDay();
            if (w === 0 || w === 6) continue;
            (away[u.id] ??= []).push({
              date: d,
              kind: r.kind === 'PAID' ? 'PAID_LEAVE' : 'UNPAID_LEAVE',
              portion: r.portion,
              label: r.portion === 'FULL' ? (r.kind === 'PAID' ? 'Casual Leave' : 'Leave without pay') : 'Half Day',
            });
          }
        }
      }
    }
    const holidays = ctx.empty
      ? []
      : ctx.db.holidays
          .filter((h) => h.date >= from && h.date <= to && (h.teamId === null || ctx.me.role === 'ADMIN' || h.teamId === ctx.me.teamId))
          .sort((a, b) => (a.date < b.date ? -1 : 1))
          .map((h) => holidayDto(ctx, h));
    return {
      from,
      to,
      tz: TZ,
      users: users.map((u) => ({ id: u.id, name: u.name, avatarUrl: u.avatarUrl, teamId: u.teamId })),
      away,
      holidays,
    };
  });

  get('/v1/leave/me/balance', (_req, ctx): LeaveBalanceResponse => {
    const asOf = todayKey();
    if (ctx.empty) {
      return { balance: { userId: ctx.me.id, asOf, balanceDays: 0, accruedDays: 0, consumedDays: 0, adjustedDays: 0 }, statement: [] };
    }
    const row = balanceRow(ctx, ctx.me, asOf);
    return {
      balance: { userId: ctx.me.id, asOf, balanceDays: row.balanceDays, accruedDays: row.accruedDays, consumedDays: row.consumedDays, adjustedDays: row.adjustedDays },
      statement: ledger(ctx, ctx.me, asOf).rows,
    };
  });

  get('/v1/leave/policy', (_req, ctx): LeavePolicyResponse => ({ policy: policyDto(ctx), approvalGateway: 'LARK', decidesInTimo: false }));

  get('/v1/leave/me/requests', (_req, ctx) => ({
    requests: ctx.empty
      ? []
      : ctx.db.leaveRequests
          .filter((r) => r.userId === ctx.me.id)
          .sort((a, b) => (a.startDate < b.startDate ? 1 : -1))
          .map((r) => leaveDto(ctx, r)),
  }));

  get('/v1/admin/leave/balances', (req, ctx): LeaveBalancesResponse => {
    const asOf = req.query.get('asOf') ?? todayKey();
    if (!isValidDateKey(asOf)) fail(400, 'invalid_date');
    const users = scopeUsers(ctx).filter(isTracked);
    return {
      asOf,
      policy: policyDto(ctx),
      rows: ctx.empty ? [] : users.sort((a, b) => a.name.localeCompare(b.name)).map((u) => balanceRow(ctx, u, asOf)),
    };
  });

  post('/v1/admin/leave/holidays', (req, ctx) => {
    requireAdmin(ctx);
    const b = bodyObject(req);
    const date = str(b.date);
    const name = str(b.name)?.trim();
    if (!isValidDateKey(date)) fail(400, 'invalid_date');
    if (!name) fail(400, 'invalid_name');
    const teamId = str(b.teamId) ?? null;
    if (ctx.db.holidays.some((h) => h.date === date && h.teamId === teamId)) fail(409, 'holiday_exists');
    const h: DbHoliday = { id: newId('hol'), date: date!, name: name!, teamId, createdAt: ctx.now };
    ctx.db.holidays.push(h);
    persist();
    return withStatus(201, holidayDto(ctx, h));
  });

  del('/v1/admin/leave/holidays/:id', (req, ctx) => {
    requireAdmin(ctx);
    if (!ctx.db.holidays.some((h) => h.id === req.params.id)) fail(404, 'not_found');
    ctx.db.holidays = ctx.db.holidays.filter((h) => h.id !== req.params.id);
    persist();
    return { ok: true };
  });

  patch('/v1/admin/leave/members/:userId', (req, ctx) => {
    requireAdmin(ctx);
    const u = requireUser(ctx, req.params.userId);
    const b = bodyObject(req);
    if (b.accrualDays !== undefined) {
      if (b.accrualDays !== null && (typeof b.accrualDays !== 'number' || b.accrualDays < 0 || b.accrualDays > 31)) fail(400, 'invalid_accrual');
      u.leaveAccrualDays = b.accrualDays === null ? null : roundToHalfDay(b.accrualDays as number);
    }
    if (b.joinedOn !== undefined) {
      if (b.joinedOn !== null && !isValidDateKey(b.joinedOn)) fail(400, 'invalid_date');
      u.joinedOn = (b.joinedOn as string | null) ?? null;
    }
    if (b.lastSaturdayOff !== undefined) u.leaveLastSaturdayOff = typeof b.lastSaturdayOff === 'boolean' ? b.lastSaturdayOff : null;
    persist();
    return balanceRow(ctx, u, todayKey());
  });

  post('/v1/admin/leave/adjust', (req, ctx) => {
    requireAdmin(ctx);
    const b = bodyObject(req);
    const u = requireUser(ctx, str(b.userId));
    const days = typeof b.days === 'number' ? b.days : Number.NaN;
    if (!Number.isFinite(days) || days === 0 || Math.abs(days / 0.5 - Math.round(days / 0.5)) > 1e-9) fail(400, 'must be a multiple of 0.5 days');
    const effectiveOn = str(b.effectiveOn);
    if (!isValidDateKey(effectiveOn)) fail(400, 'invalid_date');
    const reason = str(b.reason)?.trim();
    if (!reason) fail(400, 'reason_required');
    const row = { id: newId('adj'), userId: u.id, days, effectiveOn: effectiveOn!, reason: reason!, createdAt: ctx.now };
    ctx.db.leaveAdjustments.push(row);
    persist();
    return withStatus(201, { id: row.id, kind: 'ADJUSTMENT', days, effectiveOn: row.effectiveOn, reason: row.reason, createdAt: iso(row.createdAt) });
  });
}
