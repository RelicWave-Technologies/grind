import { hasPermission, type Permission } from '@grind/types';
import { addDays, compareKeys, dayWindow, daysInRange, isValidDateKey, todayKey, TZ } from '../clock';
import { userById, inScope } from '../derive';
import type { DbUser } from '../db';
import { fail, type Ctx, type MockRequest } from '../http';

export function requireCap(ctx: Ctx, ...perms: Permission[]): void {
  if (!perms.some((p) => hasPermission(ctx.me.role, p))) fail(403, 'forbidden');
}

export function requireAdmin(ctx: Ctx): void {
  if (ctx.me.role !== 'ADMIN') fail(403, 'forbidden');
}

export interface Range {
  from: string;
  to: string;
  tz: string;
  days: string[];
  start: number;
  end: number;
}

export function range(req: MockRequest, maxDays = 62, defaultDays = 7): Range {
  const qFrom = req.query.get('from');
  const qTo = req.query.get('to');
  if (qFrom !== null && !isValidDateKey(qFrom)) fail(400, 'invalid_date');
  if (qTo !== null && !isValidDateKey(qTo)) fail(400, 'invalid_date');
  const to = qTo ?? todayKey();
  const from = qFrom ?? addDays(to, -(defaultDays - 1));
  if (compareKeys(from, to) > 0) fail(400, 'invalid_range');
  const days = daysInRange(from, to);
  if (days.length > maxDays) fail(400, 'range_too_long', { maxDays });
  return { from, to, tz: TZ, days, start: dayWindow(from).start, end: dayWindow(to).end };
}

export function singleDay(req: MockRequest): string {
  const date = req.query.get('date');
  if (!isValidDateKey(date)) return fail(400, 'invalid_date');
  return date;
}

/** `?userId=` resolved against the caller's scope; defaults to the caller. */
export function targetUser(ctx: Ctx, raw: string | null | undefined): DbUser {
  if (!raw || raw === ctx.me.id) return ctx.me;
  if (!inScope(ctx, raw)) return fail(403, 'forbidden');
  const u = userById(ctx, raw);
  if (!u) return fail(404, 'not_found');
  return u;
}

export function requireUser(ctx: Ctx, id: string | undefined): DbUser {
  const u = id ? userById(ctx, id) : undefined;
  if (!u) return fail(404, 'not_found');
  return u;
}

export function parseIsoMs(v: unknown, field: string): number {
  if (typeof v !== 'string') return fail(400, `invalid_${field}`);
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return fail(400, `invalid_${field}`);
  return ms;
}

export function csvCell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Array<Array<string | number | null>>): string {
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}
