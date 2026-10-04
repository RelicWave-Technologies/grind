/** /v1/reports/* — self and team reports, drill-ins, corrections, month exports. */
import { ATTENDANCE_OVERRIDE_SHAPES } from '@grind/types';
import type {
  AttendanceOverrideDto,
  AttendanceOverrideHistoryResponse,
  MemberReportDayAppsResponse,
  MemberReportDayScreenshotsResponse,
  TeamMemberReportsResponse,
  TeamReportAttentionItem,
  TeamReportsResponse,
  TeamReportsSummaryResponse,
} from '@grind/types';
import { daysInRange, iso, monthBounds, todayKey, TZ } from '../clock';
import { persist, type DbUser } from '../db';
import {
  activityPercentOf,
  appUsageFor,
  computeDay,
  heatmapFor,
  profileFor,
  reportDay,
  reportDays,
  reportUsers,
  requestDto,
  screenshotsFor,
  summaryMember,
  teamMember,
  toReportApp,
  userById,
} from '../derive';
import { bodyObject, del, fail, get, put, raw, str, type Ctx } from '../http';
import { xlsx } from '../xlsx';
import { range, requireCap, singleDay, targetUser, toCsv } from './common';

function dayApps(ctx: Ctx, user: DbUser, date: string): MemberReportDayAppsResponse {
  const c = computeDay(ctx, user, date, 'shift');
  const apps = appUsageFor(ctx, user, c);
  const total = apps.reduce((s, a) => s + a.minutes, 0);
  return { date, tz: TZ, totalMinutes: total, apps: apps.map((a) => toReportApp(a, total)) };
}

function dayShots(ctx: Ctx, user: DbUser, date: string): MemberReportDayScreenshotsResponse {
  const c = computeDay(ctx, user, date, 'shift');
  const heatmap = heatmapFor(user, c, c.cal.start, c.cal.end);
  return { date, tz: TZ, activityPercent: activityPercentOf(heatmap), heatmap, screenshots: screenshotsFor(ctx, user, c, true) };
}

function teamScope(ctx: Ctx, teamId: string | null): DbUser[] {
  const users = reportUsers(ctx);
  return teamId ? users.filter((u) => u.teamId === teamId) : users;
}

function summaryTotals(members: ReturnType<typeof teamMember>[], days: number) {
  const sum = (f: (m: ReturnType<typeof teamMember>) => number) => members.reduce((s, m) => s + f(m), 0);
  return {
    memberCount: members.length,
    workedMs: sum((m) => m.workedMs),
    manualMs: sum((m) => m.manualMs),
    invalidatedMs: sum((m) => m.invalidatedMs),
    activeDays: sum((m) => m.activeDays),
    memberDays: members.length * days,
    lateDays: sum((m) => m.lateDays),
    noActivityDays: sum((m) => m.noActivityDays),
    gapCount: sum((m) => m.gapCount),
    gapMs: sum((m) => m.gapMs),
    pendingApprovals: sum((m) => m.approvals.pending),
    screenshots: sum((m) => m.screenshots),
  };
}

function monthRows(ctx: Ctx, month: string): Array<Array<string | number | null>> {
  const { from, to: monthEnd } = monthBounds(month);
  const today = todayKey();
  const to = monthEnd < today ? monthEnd : today;
  const dates = from <= to ? daysInRange(from, to) : [];
  const header: Array<string | number | null> = ['Employee', 'Email', 'Team', ...dates.map((d) => d.slice(8)), 'Present', 'Absent', 'Leave', 'Hours'];
  const rows: Array<Array<string | number | null>> = [[`Month performance — ${month}`], ['Report Month', month], [], header];
  for (const u of reportUsers(ctx)) {
    const days = dates.map((d) => reportDay(ctx, u, d));
    const codes = days.map((d) => d.attendanceCode ?? '--');
    const hours = days.reduce((s, d) => s + d.workedMs + d.meetingMs + d.manualMs, 0) / 3_600_000;
    rows.push([
      u.name,
      u.email,
      ctx.db.teams.find((t) => t.id === u.teamId)?.name ?? '',
      ...codes,
      codes.filter((c) => c === 'P').length,
      codes.filter((c) => c === 'A').length,
      codes.filter((c) => c.startsWith('PL') || c.startsWith('LWP')).length,
      Math.round(hours * 100) / 100,
    ]);
  }
  return rows;
}

export function registerReports(): void {
  get('/v1/reports/me', (req, ctx) => {
    const r = range(req);
    return { from: r.from, to: r.to, tz: r.tz, days: reportDays(ctx, ctx.me, r.from, r.to) };
  });

  get('/v1/reports/me/day-apps', (req, ctx) => dayApps(ctx, ctx.me, singleDay(req)));
  get('/v1/reports/me/day-screenshots', (req, ctx) => dayShots(ctx, ctx.me, singleDay(req)));

  get('/v1/reports/team/summary', (req, ctx): TeamReportsSummaryResponse => {
    requireCap(ctx, 'reports.team.read');
    const r = range(req, 31);
    const members = teamScope(ctx, req.query.get('teamId')).map((u) => teamMember(ctx, u, r.from, r.to));
    return { from: r.from, to: r.to, tz: r.tz, days: r.days, summary: summaryTotals(members, r.days.length), members: members.map(summaryMember) };
  });

  // Legacy route; only reached when /team/summary 404s against an old API.
  get('/v1/reports/team', (req, ctx): TeamReportsResponse => {
    requireCap(ctx, 'reports.team.read');
    const r = range(req, 31);
    const members = teamScope(ctx, null).map((u) => teamMember(ctx, u, r.from, r.to));
    const attention: TeamReportAttentionItem[] = [];
    for (const m of members) {
      for (const d of m.days) {
        if (d.shiftStatus === 'late') attention.push({ id: `late-${m.user.id}-${d.date}`, userId: m.user.id, userName: m.user.name, date: d.date, kind: 'late', severity: 'warn', title: 'Started late', detail: 'First activity after the shift buffer.' });
        if (d.approvals.pending > 0) attention.push({ id: `pending-${m.user.id}-${d.date}`, userId: m.user.id, userName: m.user.name, date: d.date, kind: 'pending_approval', severity: 'danger', title: 'Pending approval', detail: `${d.approvals.pending} request(s) waiting.` });
      }
    }
    const acts = members.map((m) => m.activityPercent).filter((x): x is number => x !== null);
    return {
      from: r.from,
      to: r.to,
      tz: r.tz,
      days: r.days,
      summary: { ...summaryTotals(members, r.days.length), activityPercent: acts.length ? Math.round(acts.reduce((s, x) => s + x, 0) / acts.length) : null },
      attention: attention.slice(0, 20),
      members,
    };
  });

  get('/v1/reports/team/member', (req, ctx): TeamMemberReportsResponse => {
    requireCap(ctx, 'reports.team.read');
    const r = range(req);
    const user = targetUser(ctx, req.query.get('userId'));
    const member = teamMember(ctx, user, r.from, r.to);
    const approvals = ctx.empty
      ? []
      : ctx.db.requests
          .filter((x) => x.userId === user.id && x.start < r.end && x.end > r.start)
          .sort((a, b) => b.start - a.start)
          .map((x) => requestDto(ctx, x));
    return { from: r.from, to: r.to, tz: r.tz, days: r.days, member, approvals, profile: profileFor(ctx, user) };
  });

  get('/v1/reports/team/member/day-apps', (req, ctx) => {
    requireCap(ctx, 'reports.team.read');
    return dayApps(ctx, targetUser(ctx, req.query.get('userId')), singleDay(req));
  });

  get('/v1/reports/team/member/day-screenshots', (req, ctx) => {
    requireCap(ctx, 'reports.team.read');
    return dayShots(ctx, targetUser(ctx, req.query.get('userId')), singleDay(req));
  });

  get('/v1/reports/attendance-override/history', (req, ctx): AttendanceOverrideHistoryResponse => {
    requireCap(ctx, 'reports.team.read');
    const user = targetUser(ctx, req.query.get('userId'));
    const date = singleDay(req);
    const entries = ctx.db.overrideHistory
      .filter((h) => h.userId === user.id && h.date === date)
      .sort((a, b) => b.setAt - a.setAt)
      .map((h) => ({ code: h.code, reason: h.reason, computedCode: h.computedCode, setAt: iso(h.setAt), setByName: h.setById ? userById(ctx, h.setById)?.name ?? null : null }));
    return { date, entries };
  });

  put('/v1/reports/attendance-override', (req, ctx): AttendanceOverrideDto => {
    requireCap(ctx, 'reports.team.read');
    const b = bodyObject(req);
    const user = targetUser(ctx, str(b.userId));
    const date = str(b.date);
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(400, 'invalid_date');
    const code = str(b.code) as (typeof ATTENDANCE_OVERRIDE_SHAPES)[number] | undefined;
    if (!code || !ATTENDANCE_OVERRIDE_SHAPES.includes(code)) fail(400, 'invalid_code');
    const reason = str(b.reason)?.trim();
    if (!reason) fail(400, 'reason_required');
    const computed = reportDay(ctx, user, date!).computedAttendanceCode ?? null;
    ctx.db.overrides = ctx.db.overrides.filter((o) => !(o.userId === user.id && o.date === date));
    ctx.db.overrides.push({ userId: user.id, date: date!, code: code!, reason: reason!, setById: ctx.me.id, setAt: ctx.now, computedCode: computed });
    ctx.db.overrideHistory.push({ userId: user.id, date: date!, code: code!, reason: reason!, computedCode: computed, setAt: ctx.now, setById: ctx.me.id });
    persist();
    return { date: date!, code: code!, reason: reason!, setByName: ctx.me.name, setAt: iso(ctx.now), stale: false };
  });

  del('/v1/reports/attendance-override', (req, ctx) => {
    requireCap(ctx, 'reports.team.read');
    const b = bodyObject(req);
    const user = targetUser(ctx, str(b.userId));
    const date = str(b.date);
    const reason = str(b.reason)?.trim();
    if (!date || !reason) fail(400, 'reason_required');
    const computed = reportDay(ctx, user, date!).computedAttendanceCode ?? null;
    ctx.db.overrides = ctx.db.overrides.filter((o) => !(o.userId === user.id && o.date === date));
    ctx.db.overrideHistory.push({ userId: user.id, date: date!, code: null, reason: reason!, computedCode: computed, setAt: ctx.now, setById: ctx.me.id });
    persist();
    return { ok: true };
  });

  get('/v1/reports/month-performance.csv', (req, ctx) => {
    requireCap(ctx, 'reports.team.read');
    const month = req.query.get('month') ?? '';
    if (!/^\d{4}-\d{2}$/.test(month)) fail(400, 'invalid_month');
    return raw(toCsv(monthRows(ctx, month)), 'text/csv; charset=utf-8', `month-performance-${month}.csv`);
  });

  get('/v1/reports/month-performance.xlsx', (req, ctx) => {
    requireCap(ctx, 'reports.team.read');
    const month = req.query.get('month') ?? '';
    if (!/^\d{4}-\d{2}$/.test(month)) fail(400, 'invalid_month');
    const bytes = xlsx(monthRows(ctx, month), 'Month performance');
    return raw(
      new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      `month-performance-${month}.xlsx`,
    );
  });
}
