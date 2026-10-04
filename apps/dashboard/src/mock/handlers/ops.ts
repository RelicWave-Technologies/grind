/**
 * Manager/admin operations: overview, the approval queue, anti-cheat flags,
 * timesheets, workspace + payroll policy, audits, payroll and API tokens.
 */
import {
  API_TOKEN_SCOPES,
  type ApiTokenDto,
  type ApiTokenScope,
  type MonitoringSettingsAuditListResponse,
  type WorkspacePolicyDto,
} from '@grind/types';
import type { ActivityFlag, DecideResult, TimesheetMatrix } from '../../lib/types';
import { DAY, HOUR, iso, todayKey } from '../clock';
import { persist, type DbFlag, type DbToken } from '../db';
import { computeDay, inScope, person, reportUsers, requestDto, scopeKind, scopeUsers, timesheetCell, userById } from '../derive';
import { bodyObject, fail, get, patch, post, raw, str, withStatus, type Ctx } from '../http';
import { monthlyPayroll, payrollPolicyDto } from '../payroll';
import { newId } from '../rng';
import { range, requireAdmin, requireCap, toCsv } from './common';
import { riskOf } from './people';

const STUCK_MS = 48 * HOUR;

function flagDto(ctx: Ctx, f: DbFlag): ActivityFlag {
  const u = userById(ctx, f.userId);
  const resolver = f.resolvedById ? userById(ctx, f.resolvedById) : undefined;
  return {
    id: f.id,
    userId: f.userId,
    user: u ? person(u) : { id: f.userId, name: 'Former member', email: 'former@saffronloop.studio', avatarUrl: null },
    type: f.type,
    windowStart: iso(f.windowStart),
    windowEnd: iso(f.windowEnd),
    riskScore: f.riskScore,
    evidence: f.evidence,
    ...(f.explanation ? { explanation: f.explanation } : {}),
    status: f.status,
    resolution: f.resolution,
    resolvedById: f.resolvedById,
    resolvedBy: resolver ? { id: resolver.id, name: resolver.name } : null,
    resolvedAt: f.resolvedAt === null ? null : iso(f.resolvedAt),
    resolvedNote: f.resolvedNote,
    createdAt: iso(f.createdAt),
  };
}

function workspacePolicyDto(ctx: Ctx): WorkspacePolicyDto {
  const p = ctx.db.workspacePolicy;
  return {
    workspaceId: 'ws_saffronloop',
    captureApps: p.captureApps,
    captureTitles: p.captureTitles,
    captureUrls: p.captureUrls,
    retentionDaysScreenshots: p.retentionDaysScreenshots,
    defaultScreenshotIntervalMin: p.defaultScreenshotIntervalMin,
    defaultIdleThresholdMin: p.defaultIdleThresholdMin,
    createdAt: iso(p.createdAt),
    updatedAt: iso(p.updatedAt),
  };
}

function tokenDto(ctx: Ctx, t: DbToken): ApiTokenDto {
  const by = userById(ctx, t.createdById);
  return {
    id: t.id,
    name: t.name,
    tokenPrefix: t.tokenPrefix,
    scopes: t.scopes,
    createdBy: by ? { id: by.id, name: by.name, email: by.email } : { id: t.createdById, name: 'Former admin', email: 'former@saffronloop.studio' },
    createdAt: iso(t.createdAt),
    lastUsedAt: t.lastUsedAt === null ? null : iso(t.lastUsedAt),
    revokedAt: t.revokedAt === null ? null : iso(t.revokedAt),
  };
}

function scopedRequests(ctx: Ctx) {
  if (ctx.empty) return [];
  const ids = new Set(scopeUsers(ctx).map((u) => u.id));
  return ctx.db.requests.filter((r) => ids.has(r.userId));
}

export function registerOps(): void {
  get('/v1/admin/overview', (_req, ctx) => {
    requireCap(ctx, 'overview.read');
    const today = todayKey();
    const users = reportUsers(ctx);
    let tracking = 0;
    let active = 0;
    let worked = 0;
    let meeting = 0;
    let manual = 0;
    for (const u of users) {
      const c = computeDay(ctx, u, today, 'shift');
      if (c.solids.some((s) => s.open)) tracking += 1;
      if (c.solids.length) active += 1;
      worked += c.totals.workedMs;
      meeting += c.totals.meetingMs;
      manual += c.totals.manualMs;
    }
    const reqs = scopedRequests(ctx);
    const pending = reqs.filter((r) => r.status === 'PENDING').sort((a, b) => a.createdAt - b.createdAt);
    const openFlags = ctx.empty ? [] : ctx.db.flags.filter((f) => f.status === 'OPEN' && inScope(ctx, f.userId)).sort((a, b) => b.createdAt - a.createdAt);
    const rejected = reqs
      .filter((r) => r.status === 'REJECTED' && r.decidedAt !== null && ctx.now - r.decidedAt < 14 * DAY)
      .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0))
      .slice(0, 5);
    const nameOf = (id: string) => ({ id, name: userById(ctx, id)?.name ?? 'Former member' });
    return {
      scope: ctx.me.role === 'ADMIN' ? 'workspace' : 'team',
      generatedAt: iso(ctx.now - 95_000),
      today: {
        date: today,
        tz: 'Asia/Kolkata',
        trackingUsers: tracking,
        activeUsers: active,
        totalUsers: users.length,
        workedHours: Math.round((worked / HOUR) * 100) / 100,
        meetingHours: Math.round((meeting / HOUR) * 100) / 100,
        manualHours: Math.round((manual / HOUR) * 100) / 100,
      },
      approvals: {
        pendingTotal: pending.length,
        pendingStuck: pending.filter((r) => ctx.now - r.createdAt > STUCK_MS).length,
        oldestPendingAgeMs: pending[0] ? ctx.now - pending[0].createdAt : 0,
        recent: pending.slice(0, 6).map((r) => ({
          id: r.id,
          user: nameOf(r.userId),
          reason: r.reason,
          createdAt: iso(r.createdAt),
          ageMs: ctx.now - r.createdAt,
          isStuck: ctx.now - r.createdAt > STUCK_MS,
        })),
      },
      flags: {
        openTotal: openFlags.length,
        recent: openFlags.slice(0, 5).map((f) => ({ id: f.id, user: nameOf(f.userId), type: f.type, windowStart: iso(f.windowStart), riskScore: f.riskScore, createdAt: iso(f.createdAt) })),
      },
      recentRejected: rejected.map((r) => ({ id: r.id, user: nameOf(r.userId), decidedAt: r.decidedAt === null ? null : iso(r.decidedAt), reason: r.reason, decidedReason: r.decidedReason })),
    };
  });

  // ---- Approval queue ------------------------------------------------------

  get('/v1/admin/manual-time-requests', (req, ctx) => {
    requireCap(ctx, 'approvals.team.decide', 'approvals.workspace.decide');
    const status = req.query.get('status') ?? 'PENDING';
    const hasRange = req.query.has('from') || req.query.has('to');
    const r = hasRange ? range(req, 62) : null;
    const rows = scopedRequests(ctx)
      .filter((x) => status === 'ALL' || x.status === status)
      .filter((x) => !r || (x.start < r.end && x.end > r.start))
      .sort((a, b) => b.start - a.start);
    return { requests: rows.map((x) => requestDto(ctx, x)), scope: scopeKind(ctx), ...(r ? { from: r.from, to: r.to, tz: r.tz } : {}) };
  });

  post('/v1/admin/manual-time-requests/:id/decide', (req, ctx): DecideResult => {
    requireCap(ctx, 'approvals.team.decide', 'approvals.workspace.decide');
    const r = ctx.db.requests.find((x) => x.id === req.params.id);
    if (!r) return fail(404, 'not_found');
    if (!inScope(ctx, r.userId)) fail(403, 'forbidden');
    const b = bodyObject(req);
    const action = str(b.action);
    if (action !== 'approve' && action !== 'reject') fail(400, 'invalid_action');
    const result = (noop: DecideResult['noop']): DecideResult => ({
      status: r.status,
      timeEntryId: r.timeEntryId,
      decidedAt: r.decidedAt === null ? null : iso(r.decidedAt),
      decidedReason: r.decidedReason,
      noop,
    });
    if (r.status === 'CANCELLED') return result('cancelled');
    if (r.status !== 'PENDING') return result('already_decided');
    if (r.userId === ctx.me.id && ctx.me.role === 'MEMBER') return result('self_approval_forbidden');
    r.decidedAt = ctx.now;
    r.approverId = ctx.me.id;
    if (action === 'approve') {
      r.status = 'APPROVED';
      r.decidedReason = str(b.reason) ?? null;
      const entryId = newId('te_manual');
      r.timeEntryId = entryId;
      ctx.db.manualEntries.push({ id: entryId, userId: r.userId, requestId: r.id, start: r.start, end: r.end, larkTaskGuid: r.larkTaskGuid, notes: null, attendeeIds: r.attendeeIds });
    } else {
      r.status = 'REJECTED';
      r.decidedReason = str(b.reason) ?? `Rejected by ${ctx.me.name} from the dashboard.`;
    }
    persist();
    return result(null);
  });

  // ---- Flags ---------------------------------------------------------------

  get('/v1/admin/flags', (req, ctx) => {
    requireCap(ctx, 'flags.team.review', 'flags.workspace.review');
    const status = req.query.get('status') === 'RESOLVED' ? 'RESOLVED' : 'OPEN';
    const flags = ctx.empty
      ? []
      : ctx.db.flags
          .filter((f) => f.status === status && inScope(ctx, f.userId))
          .sort((a, b) => (status === 'OPEN' ? b.riskScore - a.riskScore : (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0)));
    return { flags: flags.map((f) => flagDto(ctx, f)), scope: scopeKind(ctx) };
  });

  post('/v1/admin/flags/:id/resolve', (req, ctx) => {
    requireCap(ctx, 'flags.team.review', 'flags.workspace.review');
    const f = ctx.db.flags.find((x) => x.id === req.params.id);
    if (!f) return fail(404, 'not_found');
    if (!inScope(ctx, f.userId)) fail(403, 'forbidden');
    if (f.status === 'RESOLVED') fail(409, 'already_resolved');
    const b = bodyObject(req);
    const resolution = str(b.resolution);
    if (resolution !== 'DISMISSED' && resolution !== 'CONFIRMED' && resolution !== 'TIME_INVALIDATED') fail(400, 'invalid_resolution');
    f.status = 'RESOLVED';
    f.resolution = resolution as DbFlag['resolution'];
    f.resolvedById = ctx.me.id;
    f.resolvedAt = ctx.now;
    f.resolvedNote = str(b.note)?.trim() || null;
    persist();
    const invalidated = f.resolution === 'TIME_INVALIDATED';
    return { id: f.id, status: 'RESOLVED' as const, resolution: f.resolution, timeInvalidated: invalidated, invalidatedMs: invalidated ? f.windowEnd - f.windowStart : 0 };
  });

  // ---- Timesheets ----------------------------------------------------------

  get('/v1/admin/timesheets', (req, ctx): TimesheetMatrix => {
    requireCap(ctx, 'reports.team.read', 'reports.workspace.read');
    const r = range(req, 62, 14);
    const users = reportUsers(ctx);
    const cells: TimesheetMatrix['cells'] = {};
    for (const u of users) {
      const row: Record<string, ReturnType<typeof timesheetCell>> = {};
      for (const d of r.days) row[d] = timesheetCell(ctx, u, d);
      cells[u.id] = row;
    }
    return {
      from: r.from,
      to: r.to,
      tz: r.tz,
      scope: scopeKind(ctx),
      days: r.days,
      users: users.map((u) => ({ id: u.id, name: u.name, email: u.email, avatarUrl: u.avatarUrl, role: u.role })),
      cells,
    };
  });

  get('/v1/admin/timesheets.csv', (req, ctx) => {
    requireCap(ctx, 'reports.team.read', 'reports.workspace.read');
    const r = range(req, 62, 14);
    const rows: Array<Array<string | number | null>> = [['Name', 'Email', ...r.days]];
    for (const u of reportUsers(ctx)) {
      rows.push([u.name, u.email, ...r.days.map((d) => Math.round((timesheetCell(ctx, u, d).totalMs / HOUR) * 100) / 100)]);
    }
    return raw(toCsv(rows), 'text/csv; charset=utf-8', `timesheets-${r.from}-${r.to}.csv`);
  });

  // ---- Workspace policy ----------------------------------------------------

  get('/v1/admin/workspace-policy', (_req, ctx) => {
    requireCap(ctx, 'team.settings.manage', 'policy.manage');
    return workspacePolicyDto(ctx);
  });

  patch('/v1/admin/workspace-policy', (req, ctx) => {
    requireCap(ctx, 'policy.manage');
    const b = bodyObject(req);
    const p = ctx.db.workspacePolicy;
    const before = { shots: p.defaultScreenshotIntervalMin, idle: p.defaultIdleThresholdMin };
    if (typeof b.captureApps === 'boolean') p.captureApps = b.captureApps;
    if (typeof b.captureTitles === 'boolean') p.captureTitles = b.captureTitles;
    if (typeof b.captureUrls === 'boolean') p.captureUrls = b.captureUrls;
    if ((p.captureTitles || p.captureUrls) && !p.captureApps) fail(400, 'capture_apps_required');
    if (typeof b.retentionDaysScreenshots === 'number') p.retentionDaysScreenshots = b.retentionDaysScreenshots;
    if (b.defaultScreenshotIntervalMin === 1 || b.defaultScreenshotIntervalMin === 2 || b.defaultScreenshotIntervalMin === 3) p.defaultScreenshotIntervalMin = b.defaultScreenshotIntervalMin;
    if (typeof b.defaultIdleThresholdMin === 'number') p.defaultIdleThresholdMin = b.defaultIdleThresholdMin;
    const changed = before.shots !== p.defaultScreenshotIntervalMin || before.idle !== p.defaultIdleThresholdMin;
    const risk = riskOf(p.defaultScreenshotIntervalMin, p.defaultIdleThresholdMin);
    const reason = str(b.auditReason)?.trim() || null;
    if (changed && risk === 'HIGH' && !reason) fail(400, 'missing_monitoring_audit_reason');
    if (changed) {
      ctx.db.audits.push({
        id: newId('aud'),
        scope: 'WORKSPACE_POLICY',
        riskLevel: risk,
        actorId: ctx.me.id,
        targetUserId: null,
        previousScreenshotIntervalMin: before.shots,
        previousIdleThresholdMin: before.idle,
        previousIdleWarningSeconds: null,
        nextScreenshotIntervalMin: p.defaultScreenshotIntervalMin,
        nextIdleThresholdMin: p.defaultIdleThresholdMin,
        nextIdleWarningSeconds: null,
        reason,
        createdAt: ctx.now,
      });
    }
    p.updatedAt = ctx.now;
    persist();
    return workspacePolicyDto(ctx);
  });

  get('/v1/admin/monitoring-settings-audits', (req, ctx): MonitoringSettingsAuditListResponse => {
    requireCap(ctx, 'policy.manage');
    const limit = Math.min(100, Number.parseInt(req.query.get('limit') ?? '20', 10) || 20);
    const who = (id: string | null) => {
      const u = id ? userById(ctx, id) : undefined;
      return u ? { id: u.id, name: u.name, email: u.email } : null;
    };
    return {
      audits: (ctx.empty ? [] : [...ctx.db.audits])
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
        .map((a) => ({
          id: a.id,
          scope: a.scope,
          riskLevel: a.riskLevel,
          actor: who(a.actorId),
          targetUser: who(a.targetUserId),
          previousScreenshotIntervalMin: a.previousScreenshotIntervalMin,
          previousIdleThresholdMin: a.previousIdleThresholdMin,
          previousIdleWarningSeconds: a.previousIdleWarningSeconds,
          nextScreenshotIntervalMin: a.nextScreenshotIntervalMin,
          nextIdleThresholdMin: a.nextIdleThresholdMin,
          nextIdleWarningSeconds: a.nextIdleWarningSeconds,
          reason: a.reason,
          createdAt: iso(a.createdAt),
        })),
    };
  });

  // ---- Payroll -------------------------------------------------------------

  get('/v1/admin/payroll/policy', (_req, ctx) => {
    requireCap(ctx, 'payroll.manage', 'policy.manage');
    return payrollPolicyDto(ctx);
  });

  patch('/v1/admin/payroll/policy', (req, ctx) => {
    requireCap(ctx, 'payroll.manage', 'policy.manage');
    const b = bodyObject(req);
    const p = ctx.db.payrollPolicy;
    const num = (k: 'halfDayLowerMin' | 'halfDayUpperMin' | 'fullDayLowerMin' | 'fullDayUpperMin' | 'monthlyLowerMin' | 'payrollSheetSendDay') => {
      if (typeof b[k] === 'number' && Number.isFinite(b[k])) p[k] = b[k] as number;
    };
    num('halfDayLowerMin');
    num('halfDayUpperMin');
    num('fullDayLowerMin');
    num('fullDayUpperMin');
    num('monthlyLowerMin');
    num('payrollSheetSendDay');
    if (typeof b.timezone === 'string') p.timezone = b.timezone;
    if (typeof b.approvalReminderTime === 'string') p.approvalReminderTime = b.approvalReminderTime;
    if (typeof b.payrollSheetSendTime === 'string') p.payrollSheetSendTime = b.payrollSheetSendTime;
    if (Array.isArray(b.approvalReminderDays)) p.approvalReminderDays = b.approvalReminderDays.filter((x): x is number => typeof x === 'number');
    if (b.fullDayLowerMin !== undefined && b.halfDayUpperMin === undefined) p.halfDayUpperMin = p.fullDayLowerMin;
    if (p.halfDayLowerMin > p.halfDayUpperMin) fail(400, 'half_day_lower_must_be_lte_upper');
    if (p.fullDayLowerMin > p.fullDayUpperMin) fail(400, 'full_day_lower_must_be_lte_upper');
    p.updatedAt = ctx.now;
    persist();
    return payrollPolicyDto(ctx);
  });

  get('/v1/admin/payroll/monthly', (req, ctx) => {
    requireCap(ctx, 'payroll.manage');
    const month = req.query.get('month') ?? todayKey().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) fail(400, 'invalid_month');
    return monthlyPayroll(ctx, month);
  });

  get('/v1/admin/payroll/monthly.csv', (req, ctx) => {
    requireCap(ctx, 'payroll.manage');
    const month = req.query.get('month') ?? todayKey().slice(0, 7);
    const { payroll } = monthlyPayroll(ctx, month);
    const rows: Array<Array<string | number | null>> = [
      ['Name', 'Email', 'Team', 'Days present', 'Worked h', 'Meeting h', 'Manual h', 'Total h', 'Capped h', 'Full', 'Half', 'Off', 'Payable units'],
      ...payroll.rows.map((r) => [r.user.name, r.user.email, r.user.teamName, r.daysPresent, r.workedHours, r.meetingHours, r.manualHours, r.totalHours, r.cappedHours, r.fullDays, r.halfDays, r.offDays, r.payableUnits]),
    ];
    return raw(toCsv(rows), 'text/csv; charset=utf-8', `grind-payroll-${month}.csv`);
  });

  // ---- API tokens ----------------------------------------------------------

  get('/v1/admin/api-tokens', (_req, ctx) => {
    requireAdmin(ctx);
    const tokens = ctx.empty ? [] : [...ctx.db.tokens].sort((a, b) => Number(a.revokedAt !== null) - Number(b.revokedAt !== null) || b.createdAt - a.createdAt);
    return { tokens: tokens.map((t) => tokenDto(ctx, t)) };
  });

  post('/v1/admin/api-tokens', (req, ctx) => {
    requireAdmin(ctx);
    const b = bodyObject(req);
    const name = str(b.name)?.trim();
    if (!name) fail(400, 'invalid_name');
    const scopes = (Array.isArray(b.scopes) ? b.scopes : []).filter((s): s is ApiTokenScope => (API_TOKEN_SCOPES as readonly unknown[]).includes(s));
    if (!scopes.length) fail(400, 'scopes_required');
    const secret = Array.from({ length: 32 }, () => 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 57)]).join('');
    const token = { id: newId('tok'), name: name!, tokenPrefix: `timo_live_${secret.slice(0, 4)}`, scopes, createdById: ctx.me.id, createdAt: ctx.now, lastUsedAt: null, revokedAt: null };
    ctx.db.tokens.push(token);
    persist();
    return withStatus(201, { apiToken: tokenDto(ctx, token), token: `timo_live_${secret}` });
  });

  post('/v1/admin/api-tokens/:id/revoke', (req, ctx) => {
    requireAdmin(ctx);
    const t = ctx.db.tokens.find((x) => x.id === req.params.id);
    if (!t) return fail(404, 'not_found');
    t.revokedAt = t.revokedAt ?? ctx.now;
    persist();
    return { ok: true };
  });
}
