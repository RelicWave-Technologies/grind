/**
 * Everything the API computes from raw rows: the day partition, heatmaps, app
 * usage, screenshots, report days, scopes and the DTO shapes. Ported loosely
 * from apps/api (insights/day.ts, reports/member.ts) — enough fidelity that
 * the screens behave as they do against the real server.
 */
import { medianMinute, portionDays } from '@grind/types';
import type {
  DayStatus,
  ManualTimeRequestDto,
  MemberReportApp,
  MemberReportDay,
  MemberReportScreenshot,
  MemberReportTopApp,
  SelfProfileResponse,
  ShiftDto,
  TeamReportMember,
  TeamReportSummaryMember,
  TeamReportUser,
} from '@grind/types';
import type {
  ActivityHeatmap,
  AppUsageEntry,
  BlockKind,
  DayBlock,
  DayInsight,
  ManualTimeRequest,
  RejectedRequest,
  TimesheetCell,
} from '../lib/types';
import {
  approvedLeaveOn,
  entriesForDay,
  holidayOn,
  PERSONA,
  planDay,
  scheduleOn,
  shiftOf,
  type DayPlan,
  type GenEntry,
} from './activity';
import { dayWindow, daysInRange, hhmmToMinute, atMinute, iso, MIN, todayKey, TZ } from './clock';
import { dbRevision, type DbRequest, type DbShift, type DbUser } from './db';
import type { Ctx } from './http';
import { appIconDataUrl, screenshotUrl } from './images';
import { APP_MIX, APPS, BROWSER_SOURCE, TASKS, WORKSPACE, type AppDef } from './people';
import { rngFor } from './rng';

// ---------------------------------------------------------------------------
// People + scope
// ---------------------------------------------------------------------------

export function userById(ctx: Ctx, id: string): DbUser | undefined {
  return ctx.db.users.find((u) => u.id === id);
}

export function isActive(u: DbUser): boolean {
  return u.deactivatedAt === null;
}

export function isTracked(u: DbUser): boolean {
  return u.deactivatedAt === null && u.provisioningStatus === 'ACTIVE';
}

export function managedTeamIds(ctx: Ctx, userId: string): string[] {
  return ctx.db.teams.filter((t) => t.managerIds.includes(userId)).map((t) => t.id);
}

export function scopeKind(ctx: Ctx): 'self' | 'team' | 'workspace' {
  if (ctx.empty) return ctx.me.role === 'ADMIN' ? 'workspace' : ctx.me.role === 'MANAGER' ? 'team' : 'self';
  if (ctx.me.role === 'ADMIN') return 'workspace';
  if (ctx.me.role === 'MANAGER') return 'team';
  return 'self';
}

/** The caller's `req.scope.userIds`, as user rows. */
export function scopeUsers(ctx: Ctx, opts: { includeDeactivated?: boolean } = {}): DbUser[] {
  if (ctx.empty) return [ctx.me];
  const all = ctx.db.users.filter((u) => opts.includeDeactivated || isActive(u));
  if (ctx.me.role === 'ADMIN') return all;
  if (ctx.me.role === 'MANAGER') {
    const teams = managedTeamIds(ctx, ctx.me.id);
    return all.filter((u) => u.id === ctx.me.id || (u.teamId !== null && teams.includes(u.teamId)));
  }
  return all.filter((u) => u.id === ctx.me.id);
}

/** Scope users who actually track time (reports, timesheets, payroll). */
export function reportUsers(ctx: Ctx): DbUser[] {
  return scopeUsers(ctx).filter(isTracked);
}

export function inScope(ctx: Ctx, userId: string): boolean {
  return scopeUsers(ctx).some((u) => u.id === userId);
}

export function person(u: DbUser): { id: string; name: string; email: string; avatarUrl: string | null } {
  return { id: u.id, name: u.name, email: u.email, avatarUrl: u.avatarUrl };
}

export function teamNameOf(ctx: Ctx, teamId: string | null): string | null {
  if (!teamId || ctx.empty) return null;
  return ctx.db.teams.find((t) => t.id === teamId)?.name ?? null;
}

export function teamReportUser(ctx: Ctx, u: DbUser): TeamReportUser {
  const teamId = ctx.empty ? null : u.teamId;
  return { id: u.id, name: u.name, email: u.email, avatarUrl: u.avatarUrl, teamId, teamName: teamNameOf(ctx, teamId) };
}

export function managerOf(ctx: Ctx, u: DbUser): DbUser | null {
  if (ctx.empty || !u.managerId) return null;
  return userById(ctx, u.managerId) ?? null;
}

/** Who approves this person's manual time. */
export function approverFor(ctx: Ctx, u: DbUser): DbUser | null {
  const team = ctx.db.teams.find((t) => t.id === u.teamId);
  const managerId = team?.managerIds.find((id) => id !== u.id);
  if (managerId) return userById(ctx, managerId) ?? null;
  return ctx.db.users.find((x) => x.role === 'ADMIN' && x.id !== u.id && isTracked(x)) ?? null;
}

export function effectiveShift(ctx: Ctx, u: DbUser): DbShift | null {
  return ctx.empty ? null : shiftOf(ctx.db, u);
}

export function shiftDto(ctx: Ctx, s: DbShift): ShiftDto {
  return {
    id: s.id,
    workspaceId: WORKSPACE.id,
    name: s.name,
    schedule: s.schedule,
    bufferMin: s.bufferMin,
    memberCount: ctx.db.users.filter((u) => isActive(u) && u.shiftId === s.id).length,
    createdAt: iso(s.createdAt),
    updatedAt: iso(s.updatedAt),
  };
}

export function taskSummaryOf(guid: string | null): string | null {
  if (!guid) return null;
  return TASKS.find((t) => t.guid === guid)?.summary ?? null;
}

// ---------------------------------------------------------------------------
// Day partition
// ---------------------------------------------------------------------------

type Iv = { a: number; b: number };

function subtract(iv: Iv, occupied: Iv[]): Iv[] {
  let pieces: Iv[] = [iv];
  for (const o of occupied) {
    const next: Iv[] = [];
    for (const p of pieces) {
      if (o.b <= p.a || o.a >= p.b) {
        next.push(p);
        continue;
      }
      if (o.a > p.a) next.push({ a: p.a, b: o.a });
      if (o.b < p.b) next.push({ a: o.b, b: p.b });
    }
    pieces = next;
  }
  return pieces.filter((p) => p.b > p.a);
}

interface Solid {
  kind: Exclude<BlockKind, 'PENDING' | 'GAP'>;
  a: number;
  b: number;
  entry: GenEntry;
  open: boolean;
}

export interface DayComputation {
  date: string;
  cal: { start: number; end: number };
  isToday: boolean;
  isFuture: boolean;
  slot: { start: string; end: string } | null;
  shiftWin: { start: number; end: number } | null;
  shift: DbShift | null;
  dayStart: number;
  dayEnd: number;
  entries: GenEntry[];
  solids: Solid[];
  blocks: DayBlock[];
  totals: DayInsight['totals'];
  firstActivityAt: number | null;
  lastActivityAt: number | null;
  recentRejected: RejectedRequest[];
  plan: DayPlan;
}

function requestsFor(ctx: Ctx, userId: string, status: DbRequest['status'], a: number, b: number): DbRequest[] {
  if (ctx.empty) return [];
  return ctx.db.requests.filter((r) => r.userId === userId && r.status === status && r.start < b && r.end > a);
}

export function computeDay(ctx: Ctx, user: DbUser, date: string, gapScope: 'shift' | 'calendar-day'): DayComputation {
  const now = ctx.now;
  const cal = dayWindow(date);
  const isToday = cal.start <= now && now < cal.end;
  const isFuture = now < cal.start;
  const shift = effectiveShift(ctx, user);
  const slot = shift ? scheduleOn(ctx.db, user, date) : null;
  const shiftWin = slot ? { start: atMinute(date, hhmmToMinute(slot.start)), end: atMinute(date, hhmmToMinute(slot.end)) } : null;
  const frame = gapScope === 'calendar-day' ? cal : shiftWin ?? cal;
  const plan: DayPlan = ctx.empty
    ? { kind: 'none', start: 0, end: 0, punchIn: null, punchOut: null, noSamples: false }
    : planDay(ctx.db, user, date);
  const entries = ctx.empty ? [] : entriesForDay(ctx.db, user, date, now);

  const raw: Solid[] = [];
  for (const e of entries) {
    for (const s of e.segments) {
      const a = Math.max(s.start, cal.start);
      const b = Math.min(s.end, cal.end);
      if (b <= a) continue;
      raw.push({ kind: e.source === 'MANUAL' ? 'MANUAL' : s.kind, a, b, entry: e, open: s.open && isToday });
    }
  }
  const pending = requestsFor(ctx, user.id, 'PENDING', cal.start, cal.end).sort((x, y) => x.start - y.start);
  const rejected = requestsFor(ctx, user.id, 'REJECTED', cal.start, cal.end);

  let winStart = frame.start;
  let winEnd = frame.end;
  for (const s of raw) {
    winStart = Math.min(winStart, s.a);
    winEnd = Math.max(winEnd, s.b);
  }
  for (const p of pending) {
    winStart = Math.min(winStart, p.start);
    winEnd = Math.max(winEnd, p.end);
  }
  const dayStart = Math.max(winStart, cal.start);
  const dayEnd = Math.min(winEnd, cal.end);

  // Real time wins over idle, idle over manual claims.
  const priority = (k: Solid['kind']) => (k === 'MANUAL' ? 1 : k === 'IDLE_TRIMMED' ? 2 : 3);
  const occupied: Iv[] = [];
  const solids: Solid[] = [];
  for (const s of [...raw].sort((x, y) => priority(y.kind) - priority(x.kind) || x.a - y.a)) {
    const pieces = subtract({ a: Math.max(s.a, dayStart), b: Math.min(s.b, dayEnd) }, occupied);
    for (const p of pieces) {
      solids.push({ ...s, a: p.a, b: p.b });
      occupied.push(p);
    }
  }
  solids.sort((x, y) => x.a - y.a);

  const blocks: DayBlock[] = [];
  if (!isFuture) {
    for (const s of solids) {
      const block: DayBlock = {
        kind: s.kind,
        startedAt: s.a,
        endedAt: s.b,
        durationMs: s.b - s.a,
        timeEntryId: s.entry.id,
        larkTaskGuid: s.entry.larkTaskGuid,
        taskSummary: taskSummaryOf(s.entry.larkTaskGuid),
        notes: s.entry.notes,
        isOpen: s.open,
      };
      if ((s.kind === 'MEETING' || s.kind === 'MANUAL') && s.entry.attendeeIds.length) block.attendeeIds = s.entry.attendeeIds;
      if (s.entry.requestId) block.requestId = s.entry.requestId;
      blocks.push(block);
    }
    const gapCap = isToday ? Math.min(now, dayEnd) : dayEnd;
    const empties = subtract({ a: dayStart, b: gapCap }, solids.map((s) => ({ a: s.a, b: s.b })));
    for (const stretch of empties) {
      let cursor = stretch.a;
      for (const p of pending) {
        const a = Math.max(p.start, cursor);
        const b = Math.min(p.end, stretch.b);
        if (b <= a) continue;
        if (a > cursor) blocks.push({ kind: 'GAP', startedAt: cursor, endedAt: a, durationMs: a - cursor });
        const block: DayBlock = {
          kind: 'PENDING',
          startedAt: a,
          endedAt: b,
          durationMs: b - a,
          requestId: p.id,
          reason: p.reason,
          larkTaskGuid: p.larkTaskGuid,
          taskSummary: p.taskSummary,
        };
        if (p.attendeeIds.length) block.attendeeIds = p.attendeeIds;
        blocks.push(block);
        cursor = b;
      }
      if (cursor < stretch.b) blocks.push({ kind: 'GAP', startedAt: cursor, endedAt: stretch.b, durationMs: stretch.b - cursor });
    }
    blocks.sort((x, y) => x.startedAt - y.startedAt);
  }

  const totals = { workedMs: 0, meetingMs: 0, manualMs: 0, idleTrimmedMs: 0, pendingMs: 0, gapMs: 0, invalidatedMs: 0 };
  for (const b of blocks) {
    if (b.kind === 'WORK') totals.workedMs += b.durationMs;
    else if (b.kind === 'MEETING') totals.meetingMs += b.durationMs;
    else if (b.kind === 'MANUAL') totals.manualMs += b.durationMs;
    else if (b.kind === 'IDLE_TRIMMED') totals.idleTrimmedMs += b.durationMs;
    else if (b.kind === 'PENDING') totals.pendingMs += b.durationMs;
    else if (b.kind === 'GAP') totals.gapMs += b.durationMs;
  }
  totals.invalidatedMs = invalidatedMs(ctx, user, entries);

  const first = solids[0];
  const last = solids[solids.length - 1];
  return {
    date,
    cal,
    isToday,
    isFuture,
    slot,
    shiftWin,
    shift,
    dayStart,
    dayEnd,
    entries,
    solids,
    blocks,
    totals,
    firstActivityAt: first ? first.a : null,
    lastActivityAt: last ? (isToday ? Math.max(last.b, now) : last.b) : null,
    recentRejected: rejected
      .map((r) => ({
        id: r.id,
        requestedStart: Math.max(r.start, dayStart),
        requestedEnd: Math.min(r.end, dayEnd),
        reason: r.reason,
        decidedReason: r.decidedReason,
        larkTaskGuid: r.larkTaskGuid,
        taskSummary: r.taskSummary,
      }))
      .filter((r) => r.requestedEnd > r.requestedStart)
      .sort((x, y) => x.requestedStart - y.requestedStart),
    plan,
  };
}

function invalidatedMs(ctx: Ctx, user: DbUser, entries: GenEntry[]): number {
  const windows = ctx.db.flags.filter((f) => f.userId === user.id && f.resolution === 'TIME_INVALIDATED');
  if (!windows.length) return 0;
  let total = 0;
  for (const e of entries) {
    if (e.source === 'MANUAL') continue;
    for (const s of e.segments) {
      if (s.kind === 'IDLE_TRIMMED') continue;
      for (const w of windows) total += Math.max(0, Math.min(s.end, w.windowEnd) - Math.max(s.start, w.windowStart));
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Activity samples: heatmap, app usage, screenshots
// ---------------------------------------------------------------------------

const BUCKET_MS = 10 * MIN;

function workScore(user: DbUser, bucketStart: number): number {
  const [lo, hi] = PERSONA[user.persona].act;
  return rngFor('act', user.id, bucketStart).int(lo, hi);
}

export function heatmapFor(user: DbUser, c: DayComputation, start: number, end: number): ActivityHeatmap {
  const buckets: Array<number | null> = [];
  const sampleCounts: number[] = [];
  const segs = c.entries.filter((e) => e.source === 'TRACKED').flatMap((e) => e.segments);
  for (let bs = start; bs < end; bs += BUCKET_MS) {
    const be = Math.min(bs + BUCKET_MS, end);
    let work = 0;
    let meet = 0;
    let idle = 0;
    for (const s of segs) {
      const ov = Math.max(0, Math.min(s.end, be) - Math.max(s.start, bs));
      if (!ov) continue;
      if (s.kind === 'WORK') work += ov;
      else if (s.kind === 'MEETING') meet += ov;
      else idle += ov;
    }
    const samples = Math.round((work + meet + idle) / MIN);
    if (c.plan.noSamples || samples === 0) {
      buckets.push(null);
      sampleCounts.push(0);
      continue;
    }
    const meetScore = rngFor('meet', user.id, bs).int(12, 35);
    const value = Math.round((work * workScore(user, bs) + meet * meetScore) / (work + meet + idle));
    buckets.push(Math.max(0, Math.min(100, value)));
    sampleCounts.push(samples);
  }
  return { bucketMs: BUCKET_MS, buckets, sampleCounts };
}

export function activityPercentOf(h: ActivityHeatmap): number | null {
  let sum = 0;
  let weight = 0;
  h.buckets.forEach((v, i) => {
    if (v === null) return;
    const w = h.sampleCounts[i] ?? 0;
    sum += v * w;
    weight += w;
  });
  return weight > 0 ? Math.round(sum / weight) : null;
}

const KEY_RATE: Record<AppDef['screen'], number> = { code: 38, terminal: 30, design: 7, chat: 26, doc: 32, sheet: 18, browser: 10, call: 2 };
const CLICK_RATE: Record<AppDef['screen'], number> = { code: 4, terminal: 1, design: 11, chat: 4, doc: 3, sheet: 9, browser: 7, call: 1 };
const SCROLL_RATE: Record<AppDef['screen'], number> = { code: 3, terminal: 1, design: 2, chat: 5, doc: 7, sheet: 4, browser: 9, call: 0 };

interface AppIdentity {
  key: string;
  app: string;
  appBundle: string | null;
  domain: string | null;
  sourceApp: string | null;
  sourceAppBundle: string | null;
  screen: AppDef['screen'];
}

function identityOf(ctx: Ctx, appKey: string): AppIdentity | null {
  const policy = ctx.db.workspacePolicy;
  if (!policy.captureApps) return null;
  const def = APPS[appKey] ?? APPS.lark!;
  if (def.domain) {
    if (!policy.captureUrls) {
      return { key: 'app:chrome', app: BROWSER_SOURCE.sourceApp, appBundle: BROWSER_SOURCE.sourceAppBundle, domain: null, sourceApp: null, sourceAppBundle: null, screen: 'browser' };
    }
    return { key: `site:${def.domain}`, app: def.domain, appBundle: null, domain: def.domain, sourceApp: BROWSER_SOURCE.sourceApp, sourceAppBundle: BROWSER_SOURCE.sourceAppBundle, screen: def.screen };
  }
  return { key: `app:${def.app}`, app: def.app, appBundle: def.bundle, domain: null, sourceApp: null, sourceAppBundle: null, screen: def.screen };
}

interface AppAgg extends AppIdentity {
  minutes: number;
  keystrokes: number;
  clicks: number;
  scrolls: number;
}

export function appUsageFor(ctx: Ctx, user: DbUser, c: DayComputation): AppAgg[] {
  const map = new Map<string, AppAgg>();
  const add = (appKey: string, ms: number) => {
    const id = identityOf(ctx, appKey);
    if (!id || ms <= 0) return;
    const minutes = ms / MIN;
    const cur = map.get(id.key) ?? { ...id, minutes: 0, keystrokes: 0, clicks: 0, scrolls: 0 };
    cur.minutes += minutes;
    cur.keystrokes += minutes * KEY_RATE[id.screen];
    cur.clicks += minutes * CLICK_RATE[id.screen];
    cur.scrolls += minutes * SCROLL_RATE[id.screen];
    map.set(id.key, cur);
  };
  if (c.plan.noSamples) return [];
  const mix = APP_MIX[user.discipline];
  for (const e of c.entries) {
    if (e.source === 'MANUAL') continue;
    for (const s of e.segments) {
      if (s.kind === 'IDLE_TRIMMED') continue;
      const ms = s.end - s.start;
      if (s.kind === 'MEETING') {
        add(e.app, ms);
        continue;
      }
      add(e.app, ms * 0.7);
      const rest = ms * 0.3;
      const chunks = Math.max(1, Math.round(rest / (10 * MIN)));
      const r = rngFor('apps', e.id, s.start);
      for (let i = 0; i < chunks; i++) add(r.weighted(mix), rest / chunks);
    }
  }
  return [...map.values()]
    .map((a) => ({
      ...a,
      minutes: Math.round(a.minutes),
      keystrokes: Math.round(a.keystrokes),
      clicks: Math.round(a.clicks),
      scrolls: Math.round(a.scrolls),
    }))
    .filter((a) => a.minutes > 0)
    .sort((x, y) => y.minutes - x.minutes || x.app.localeCompare(y.app));
}

export function toAppUsageEntry(a: AppAgg): AppUsageEntry {
  return {
    app: a.app,
    appBundle: a.appBundle,
    ...(a.domain ? { domain: a.domain, sourceApp: a.sourceApp, sourceAppBundle: a.sourceAppBundle } : {}),
    iconUrl: appIconDataUrl(a.app),
    minutes: a.minutes,
    keystrokes: a.keystrokes,
    clicks: a.clicks,
  };
}

export function toTopApp(a: AppAgg, totalMinutes: number): MemberReportTopApp {
  return {
    app: a.app,
    appBundle: a.appBundle,
    ...(a.domain ? { domain: a.domain, sourceApp: a.sourceApp, sourceAppBundle: a.sourceAppBundle } : {}),
    iconUrl: appIconDataUrl(a.app),
    minutes: a.minutes,
    share: totalMinutes > 0 ? a.minutes / totalMinutes : 0,
  };
}

export function toReportApp(a: AppAgg, totalMinutes: number): MemberReportApp {
  return { ...toTopApp(a, totalMinutes), keystrokes: a.keystrokes, clicks: a.clicks, scrolls: a.scrolls };
}

const SCREEN_SIZE: Record<string, [number, number]> = { darwin: [2880, 1800], win32: [1920, 1080], linux: [2560, 1440] };

export function screenshotsFor(ctx: Ctx, user: DbUser, c: DayComputation, withUrls: boolean): MemberReportScreenshot[] {
  if (ctx.empty) return [];
  const r = rngFor('shots', user.id, c.date);
  const heat = heatmapFor(user, c, c.cal.start, c.cal.end);
  const invalid = ctx.db.flags.filter((f) => f.userId === user.id && f.resolution === 'TIME_INVALIDATED');
  const [w, h] = SCREEN_SIZE[user.agent.platform ?? 'darwin'] ?? [2880, 1800];
  const out: MemberReportScreenshot[] = [];
  const entries = c.entries.filter((e) => e.source === 'TRACKED');
  for (const e of entries) {
    for (const s of e.segments) {
      if (s.kind === 'IDLE_TRIMMED') continue;
      for (let t = s.start + r.int(1, 4) * MIN; t < s.end; t += r.int(5, 8) * MIN) {
        const appKey = s.kind === 'MEETING' || r.chance(0.72) ? e.app : r.weighted(APP_MIX[user.discipline]);
        const id = identityOf(ctx, appKey);
        const def = APPS[appKey] ?? APPS.lark!;
        const bucket = Math.floor((t - c.cal.start) / BUCKET_MS);
        const activity = c.plan.noSamples ? null : heat.buckets[bucket] ?? null;
        const blurred = (def.screen === 'chat' && r.chance(0.3)) || r.chance(0.02);
        const variant = r.int(0, 3);
        const url = withUrls ? screenshotUrl(def.screen, variant, def.domain ?? def.app, blurred) : null;
        out.push({
          id: `ss_${e.id}_${Math.round(t / 1000)}`,
          capturedAt: iso(t),
          thumbUrl: url,
          fullUrl: url,
          width: w,
          height: h,
          bytes: r.int(260_000, 940_000),
          blurred,
          invalidated: invalid.some((f) => t >= f.windowStart && t < f.windowEnd),
          activityPercent: activity,
          keystrokes: activity === null ? null : Math.round((activity / 100) * r.int(20, 140)),
          clicks: activity === null ? null : Math.round((activity / 100) * r.int(4, 40)),
          scrolls: activity === null ? null : r.int(0, 30),
          mouseDistancePx: activity === null ? null : r.int(400, 9_000),
          dominantApp: id?.app ?? null,
          dominantAppBundle: id?.appBundle ?? null,
          timeEntryId: e.id,
        });
      }
    }
  }
  return out;
}

export function dayInsight(ctx: Ctx, user: DbUser, date: string, gapScope: 'shift' | 'calendar-day'): DayInsight {
  const c = computeDay(ctx, user, date, gapScope);
  const apps = appUsageFor(ctx, user, c);
  return {
    date,
    timezone: TZ,
    calendarDayStart: c.cal.start,
    calendarDayEnd: c.cal.end,
    dayStart: c.dayStart,
    dayEnd: c.dayEnd,
    isFuture: c.isFuture,
    isToday: c.isToday,
    shift:
      c.slot && c.shift && c.shiftWin
        ? { name: c.shift.name, start: c.slot.start, end: c.slot.end, startedAt: c.shiftWin.start, endedAt: c.shiftWin.end }
        : null,
    firstActivityAt: c.firstActivityAt,
    lastActivityAt: c.lastActivityAt,
    totals: c.totals,
    blocks: c.blocks,
    recentRejected: c.recentRejected,
    activity: heatmapFor(user, c, c.dayStart, c.dayEnd),
    fullDayActivity: heatmapFor(user, c, c.cal.start, c.cal.end),
    appUsage: { totalMinutes: apps.reduce((s, a) => s + a.minutes, 0), topApps: apps.slice(0, 10).map(toAppUsageEntry) },
  };
}

// ---------------------------------------------------------------------------
// Calendar status + attendance codes
// ---------------------------------------------------------------------------

export function dayStatusFor(ctx: Ctx, user: DbUser, date: string): DayStatus {
  const shift = effectiveShift(ctx, user);
  const base = { date, portion: null, paid: false, chargedDays: 0, expectedFraction: 0, shiftName: shift?.name ?? null, label: null };
  if (!shift) return { ...base, kind: 'NO_SHIFT' };
  const holiday = holidayOn(ctx.db, user, date);
  if (holiday) return { ...base, kind: 'HOLIDAY', paid: true, label: holiday.name };
  if (!scheduleOn(ctx.db, user, date)) return { ...base, kind: 'WEEKLY_OFF' };
  const leave = approvedLeaveOn(ctx.db, user.id, date);
  if (leave) {
    const paid = leave.kind === 'PAID';
    return {
      ...base,
      kind: paid ? 'PAID_LEAVE' : 'UNPAID_LEAVE',
      portion: leave.portion,
      paid,
      chargedDays: paid ? portionDays(leave.portion) : 0,
      expectedFraction: leave.portion === 'FULL' ? 0 : 0.5,
      label: leave.portion === 'FULL' ? (paid ? 'Casual Leave' : 'Leave without pay') : 'Half Day',
    };
  }
  return { ...base, kind: 'WORKING', expectedFraction: 1 };
}

type ReportCode = NonNullable<MemberReportDay['attendanceCode']>;

export function computedCode(status: DayStatus | null, trackedMinutes: number): ReportCode {
  switch (status?.kind) {
    case 'HOLIDAY':
      return 'HL';
    case 'WEEKLY_OFF':
      return 'WO';
    case 'PAID_LEAVE':
      return status.expectedFraction > 0 ? 'PL_HD' : 'PL';
    case 'UNPAID_LEAVE':
      return status.expectedFraction > 0 ? 'LWP_HD' : 'LWP';
    default:
      break;
  }
  if (trackedMinutes > 0) return 'P';
  if (!status || status.kind === 'NO_SHIFT') return '--';
  return 'A';
}

function overrideReportCode(code: string): ReportCode {
  switch (code) {
    case 'HALF_LEAVE':
    case 'HD':
    case 'PL_HD':
      return 'PL_HD';
    case 'LWP_HD':
      return 'LWP_HD';
    case 'FULL_LEAVE':
    case 'PL':
      return 'PL';
    case 'LWP':
      return 'LWP';
    case 'A':
      return 'A';
    default:
      return 'P';
  }
}

// ---------------------------------------------------------------------------
// Report days
// ---------------------------------------------------------------------------

let reportRev = -1;
const reportCache = new Map<string, MemberReportDay>();

export function reportDay(ctx: Ctx, user: DbUser, date: string): MemberReportDay {
  const cacheable = date !== todayKey();
  const key = `${ctx.empty ? 1 : 0}|${user.id}|${date}`;
  if (reportRev !== dbRevision()) {
    reportCache.clear();
    reportRev = dbRevision();
  }
  if (cacheable) {
    const hit = reportCache.get(key);
    if (hit) return hit;
  }
  const c = computeDay(ctx, user, date, 'shift');
  const gaps = c.blocks.filter((b) => b.kind === 'GAP');
  const apps = appUsageFor(ctx, user, c);
  const totalAppMinutes = apps.reduce((s, a) => s + a.minutes, 0);
  const heat = heatmapFor(user, c, c.cal.start, c.cal.end);
  const status = dayStatusFor(ctx, user, date);
  const trackedMs = c.totals.workedMs + c.totals.meetingMs + c.totals.manualMs;
  const computed = computedCode(status, Math.round(trackedMs / MIN));
  const override = ctx.empty ? undefined : ctx.db.overrides.find((o) => o.userId === user.id && o.date === date);
  const firstActivityMs = c.solids[0]?.a ?? null;
  const lastActivityMs = c.solids[c.solids.length - 1]?.b ?? null;
  const day: MemberReportDay = {
    date,
    workedMs: c.totals.workedMs,
    meetingMs: c.totals.meetingMs,
    manualMs: c.totals.manualMs,
    invalidatedMs: c.totals.invalidatedMs ?? 0,
    firstActivityMs,
    lastActivityMs,
    punchInMinute: c.plan.punchIn,
    punchOutMinute: c.plan.punchOut,
    shiftStatus: shiftStatusOf(c, firstActivityMs),
    gaps: { count: gaps.length, totalMs: gaps.reduce((s, g) => s + g.durationMs, 0) },
    approvals: approvalCounts(ctx, user.id, c.cal.start, c.cal.end),
    activityPercent: activityPercentOf(heat),
    screenshots: { count: screenshotsFor(ctx, user, c, false).length },
    topApps: apps.slice(0, 5).map((a) => toTopApp(a, totalAppMinutes)),
    dayStatus: status,
    attendanceCode: override ? overrideReportCode(override.code) : computed,
    computedAttendanceCode: computed,
    attendanceOverride: override
      ? { code: override.code, stale: override.computedCode !== null && override.computedCode !== computed }
      : null,
  };
  if (cacheable) reportCache.set(key, day);
  return day;
}

function shiftStatusOf(c: DayComputation, first: number | null): MemberReportDay['shiftStatus'] {
  if (!c.shift || !c.shiftWin) return 'no_shift';
  if (first === null) return 'no_activity';
  if (first < c.shiftWin.start) return 'early';
  return first <= c.shiftWin.start + c.shift.bufferMin * MIN ? 'on_time' : 'late';
}

function approvalCounts(ctx: Ctx, userId: string, a: number, b: number) {
  const out = { approved: 0, pending: 0, rejected: 0 };
  if (ctx.empty) return out;
  for (const r of ctx.db.requests) {
    if (r.userId !== userId || r.start >= b || r.end <= a) continue;
    if (r.status === 'APPROVED') out.approved += 1;
    else if (r.status === 'PENDING') out.pending += 1;
    else if (r.status === 'REJECTED') out.rejected += 1;
  }
  return out;
}

export function reportDays(ctx: Ctx, user: DbUser, from: string, to: string): MemberReportDay[] {
  return daysInRange(from, to).map((d) => reportDay(ctx, user, d));
}

function aggregateTopApps(days: MemberReportDay[]): MemberReportTopApp[] {
  const by = new Map<string, MemberReportTopApp>();
  let total = 0;
  for (const d of days) {
    for (const a of d.topApps) {
      const key = a.domain ?? `${a.app}|${a.appBundle ?? ''}`;
      const cur = by.get(key);
      if (cur) cur.minutes += a.minutes;
      else by.set(key, { ...a });
      total += a.minutes;
    }
  }
  return [...by.values()]
    .map((a) => ({ ...a, share: total > 0 ? a.minutes / total : 0 }))
    .sort((x, y) => y.minutes - x.minutes || x.app.localeCompare(y.app))
    .slice(0, 3);
}

export function teamMember(ctx: Ctx, user: DbUser, from: string, to: string): TeamReportMember {
  const days = reportDays(ctx, user, from, to);
  const m = {
    workedMs: 0,
    manualMs: 0,
    invalidatedMs: 0,
    activeDays: 0,
    lateDays: 0,
    onTimeDays: 0,
    offDays: 0,
    noActivityDays: 0,
    gapCount: 0,
    gapMs: 0,
    approved: 0,
    pending: 0,
    rejected: 0,
    screenshots: 0,
    actSum: 0,
    actN: 0,
  };
  for (const d of days) {
    const worked = d.workedMs + d.meetingMs + d.manualMs;
    m.workedMs += worked;
    m.manualMs += d.manualMs;
    m.invalidatedMs += d.invalidatedMs;
    if (worked > 0) m.activeDays += 1;
    if (d.shiftStatus === 'late') m.lateDays += 1;
    if (d.shiftStatus === 'on_time' || d.shiftStatus === 'early') m.onTimeDays += 1;
    if (d.shiftStatus === 'no_shift') m.offDays += 1;
    if (d.shiftStatus === 'no_activity') m.noActivityDays += 1;
    m.gapCount += d.gaps.count;
    m.gapMs += d.gaps.totalMs;
    m.approved += d.approvals.approved;
    m.pending += d.approvals.pending;
    m.rejected += d.approvals.rejected;
    m.screenshots += d.screenshots.count;
    if (d.activityPercent !== null) {
      m.actSum += d.activityPercent;
      m.actN += 1;
    }
  }
  return {
    user: teamReportUser(ctx, user),
    workedMs: m.workedMs,
    manualMs: m.manualMs,
    invalidatedMs: m.invalidatedMs,
    activeDays: m.activeDays,
    lateDays: m.lateDays,
    onTimeDays: m.onTimeDays,
    offDays: m.offDays,
    noActivityDays: m.noActivityDays,
    gapCount: m.gapCount,
    gapMs: m.gapMs,
    approvals: { approved: m.approved, pending: m.pending, rejected: m.rejected },
    activityPercent: m.actN > 0 ? Math.round(m.actSum / m.actN) : null,
    screenshots: m.screenshots,
    topApps: aggregateTopApps(days),
    days,
  };
}

export function summaryMember(member: TeamReportMember): TeamReportSummaryMember {
  return {
    user: member.user,
    workedMs: member.workedMs,
    manualMs: member.manualMs,
    invalidatedMs: member.invalidatedMs,
    activeDays: member.activeDays,
    lateDays: member.lateDays,
    onTimeDays: member.onTimeDays,
    offDays: member.offDays,
    noActivityDays: member.noActivityDays,
    gapCount: member.gapCount,
    gapMs: member.gapMs,
    approvals: member.approvals,
    screenshots: member.screenshots,
    typicalPunchInMinute: medianMinute(member.days.map((d) => d.punchInMinute)),
    typicalPunchOutMinute: medianMinute(member.days.map((d) => d.punchOutMinute)),
  };
}

// ---------------------------------------------------------------------------
// Timesheet cells
// ---------------------------------------------------------------------------

export function timesheetCell(ctx: Ctx, user: DbUser, date: string): TimesheetCell {
  const c = computeDay(ctx, user, date, 'shift');
  const heat = heatmapFor(user, c, c.cal.start, c.cal.end);
  const total = c.totals.workedMs + c.totals.meetingMs + c.totals.manualMs;
  return {
    workedMs: c.totals.workedMs,
    meetingMs: c.totals.meetingMs,
    manualMs: c.totals.manualMs,
    invalidatedMs: c.totals.invalidatedMs ?? 0,
    totalMs: total,
    firstActivityMs: c.solids[0]?.a ?? null,
    lastActivityMs: c.solids[c.solids.length - 1]?.b ?? null,
    activitySampleCount: heat.sampleCounts.reduce((s, n) => s + n, 0),
  };
}

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export function requestDto(ctx: Ctx, r: DbRequest): ManualTimeRequestDto & ManualTimeRequest {
  const u = userById(ctx, r.userId);
  const approver = r.approverId ? userById(ctx, r.approverId) : undefined;
  const decided = r.status === 'APPROVED' || r.status === 'REJECTED';
  return {
    id: r.id,
    clientUuid: r.clientUuid,
    version: 1,
    userId: r.userId,
    approverId: r.approverId,
    larkTaskGuid: r.larkTaskGuid,
    taskSummary: r.taskSummary,
    larkMessageId: r.autoApproved ? null : `om_${r.id.slice(-10)}`,
    larkDeliveryStatus: r.autoApproved ? 'none' : 'sent',
    latestLarkMessageStatus: r.autoApproved ? null : decided ? 'DECIDED' : r.status === 'CANCELLED' ? 'CANCELLED' : 'SENT',
    requestedStart: iso(r.start),
    requestedEnd: iso(r.end),
    reason: r.reason,
    status: r.status,
    autoApproved: r.autoApproved,
    decidedAt: r.decidedAt === null ? null : iso(r.decidedAt),
    decidedReason: r.decidedReason,
    createdAt: iso(r.createdAt),
    attendeeIds: r.attendeeIds,
    user: u ? person(u) : { id: r.userId, name: 'Former member', email: 'former@saffronloop.studio', avatarUrl: null },
    approver: approver ? person(approver) : null,
    triage: r.status === 'PENDING' ? r.triage : null,
  };
}

export function profileFor(ctx: Ctx, user: DbUser): SelfProfileResponse {
  const team = ctx.empty ? undefined : ctx.db.teams.find((t) => t.id === user.teamId);
  const manager = managerOf(ctx, user);
  const shift = effectiveShift(ctx, user);
  const policy = ctx.db.workspacePolicy;
  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      role: user.role,
      displayRole: user.role,
      createdAt: iso(user.createdAt),
    },
    workspace: { id: WORKSPACE.id, name: WORKSPACE.name, timezone: TZ, createdAt: iso(ctx.db.workspaceCreatedAt) },
    team: team ? { id: team.id, name: team.name, memberCount: ctx.db.users.filter((u) => isActive(u) && u.teamId === team.id).length } : null,
    manager: manager ? person(manager) : null,
    shift: shift ? { ...shiftDto(ctx, shift), assignedAt: user.shiftAssignedAt === null ? null : iso(user.shiftAssignedAt) } : null,
    policy: {
      captureApps: policy.captureApps,
      captureTitles: policy.captureTitles,
      captureUrls: policy.captureUrls,
      retentionDaysScreenshots: policy.retentionDaysScreenshots,
    },
  };
}
