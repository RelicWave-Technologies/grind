/** People, org teams, shifts and per-member monitoring settings. */
import { MEMBER_SETTING_DEFAULTS, type Role, type TeamMemberSettingsDto, type TeamSettingsResponse } from '@grind/types';
import type { ShiftSchedule } from '@grind/types/shifts';
import type { Team } from '../../lib/types';
import { DAY, iso, todayKey } from '../clock';
import { persist, type DbUser } from '../db';
import { isTrackingNow } from '../activity';
import { isActive, managerOf, person, scopeKind, scopeUsers, shiftDto, userById } from '../derive';
import { bodyObject, del, fail, get, patch, post, str, withStatus, type Ctx } from '../http';
import { avatarDataUrl } from '../images';
import { newId } from '../rng';
import { requireAdmin, requireCap, requireUser } from './common';

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function adminUser(ctx: Ctx, u: DbUser) {
  const exposeHealth = ctx.me.role === 'ADMIN';
  const managed = ctx.db.teams.find((t) => t.managerIds.includes(u.id));
  const tracking = exposeHealth && u.agent.platform !== null && isActive(u) ? isTrackingNow(ctx.db, u, ctx.now) : false;
  const a = u.agent;
  const seen = a.platform === null ? null : tracking ? ctx.now - 40_000 : ctx.now - (u.persona === 'night' ? 14 : 2.5) * 3_600_000;
  const heartbeatAt = seen === null ? null : iso(seen);
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    avatarUrl: u.avatarUrl,
    role: u.role,
    activityRoleTitle: u.activityRoleTitle,
    teamId: ctx.empty ? null : u.teamId,
    managerId: ctx.empty ? null : u.managerId,
    managesTeamId: ctx.empty ? null : managed?.id ?? null,
    managesTeamName: ctx.empty ? null : managed?.name ?? null,
    shiftId: ctx.empty ? null : u.shiftId,
    deactivatedAt: u.deactivatedAt === null ? null : iso(u.deactivatedAt),
    provisioningStatus: u.provisioningStatus,
    createdAt: iso(u.createdAt),
    birthDate: exposeHealth ? u.birthDate : null,
    agentLastSeenAt: exposeHealth ? heartbeatAt : null,
    agentPresence: exposeHealth ? (a.platform === null ? null : tracking ? ('ONLINE' as const) : ('OFFLINE' as const)) : null,
    agentState: exposeHealth ? (a.platform === null ? null : tracking ? ('RUNNING' as const) : u.persona === 'erratic' ? ('PAUSED_IDLE' as const) : ('IDLE' as const)) : null,
    agentVersion: exposeHealth ? a.version : null,
    agentPlatform: exposeHealth ? a.platform : null,
    agentScreenPermissionStatus: exposeHealth && a.screen ? (a.screen === 'ok' ? 'granted' : 'denied') : null,
    agentScreenCaptureHealth: exposeHealth && a.screen ? (a.screen === 'ok' ? 'healthy' : 'degraded') : null,
    agentScreenPermissionState: exposeHealth ? a.screen : null,
    agentAccessibilityTrusted: exposeHealth ? a.accessibilityTrusted : null,
    agentAccessibilityReady: exposeHealth ? a.accessibilityReady : null,
    agentAccessibilityRecording: exposeHealth && a.platform === 'darwin' ? tracking : null,
    agentAccessibilityCapturing: exposeHealth && a.platform === 'darwin' ? tracking : null,
    agentAccessibilityHookRunning: exposeHealth ? a.hookRunning : null,
    agentPermissionsUpdatedAt: exposeHealth ? heartbeatAt : null,
    agentLaunchAtLoginState: exposeHealth ? a.launch : null,
    agentLaunchOrigin: exposeHealth ? a.origin : null,
    agentLaunchAtLoginUpdatedAt: exposeHealth && a.launch ? heartbeatAt : null,
    ...(exposeHealth ? { idleWarningSeconds: u.idleWarningSeconds } : {}),
  };
}

const ROLE_ORDER: Record<Role, number> = { ADMIN: 0, MANAGER: 1, MEMBER: 2 };

function sortUsers(users: DbUser[]): DbUser[] {
  return [...users].sort(
    (a, b) =>
      Number(a.deactivatedAt !== null) - Number(b.deactivatedAt !== null) ||
      ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
      a.name.localeCompare(b.name),
  );
}

/** A deterministic, plausible bill for deleting someone. */
function deletionPlan(ctx: Ctx, u: DbUser) {
  const tenureDays = Math.max(1, Math.round((ctx.now - u.createdAt) / DAY));
  const workDays = u.provisioningStatus === 'PENDING' ? 0 : Math.round(tenureDays * (5 / 7) * 0.93);
  return {
    userId: u.id,
    name: u.name,
    email: u.email,
    destroys: {
      timeEntries: workDays * 7,
      activitySamples: workDays * 470,
      screenshots: workDays * 78,
      manualTimeRequests: ctx.db.requests.filter((r) => r.userId === u.id).length + Math.round(workDays / 15),
      activityFlags: ctx.db.flags.filter((f) => f.userId === u.id).length,
      leaveRequests: ctx.db.leaveRequests.filter((l) => l.userId === u.id).length,
      leaveLedgerEntries: Math.round(tenureDays / 30) + ctx.db.leaveAdjustments.filter((l) => l.userId === u.id).length,
      attendancePunches: Math.round(workDays * 0.78) * 2,
      attendanceOverrides: ctx.db.overrides.filter((o) => o.userId === u.id).length,
      sessions: u.agent.platform ? 2 : 0,
    },
    anonymises: { manualTimeRequestsTheyApproved: ctx.db.requests.filter((r) => r.approverId === u.id && r.userId !== u.id).length },
    orphanedScreenshotFiles: workDays > 0 ? Math.round(workDays * 78 * 0.02) : 0,
  };
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

function teamDto(ctx: Ctx, id: string): Team {
  const t = ctx.db.teams.find((x) => x.id === id);
  if (!t) return fail(404, 'not_found');
  const managers = t.managerIds.map((mid) => userById(ctx, mid)).filter((u): u is DbUser => !!u);
  return {
    id: t.id,
    name: t.name,
    managers: managers.map((m) => ({ ...person(m), role: m.role, teamId: m.teamId })),
    managerIds: managers.map((m) => m.id),
    managerCount: managers.length,
    managerId: managers[0]?.id ?? null,
    memberCount: ctx.db.users.filter((u) => isActive(u) && u.teamId === t.id).length,
    createdAt: iso(t.createdAt),
  };
}

/** Keep roles, team membership and reporting lines consistent with managerIds. */
function syncManagers(ctx: Ctx): void {
  for (const u of ctx.db.users) {
    const manages = ctx.db.teams.find((t) => t.managerIds.includes(u.id));
    if (manages && u.role === 'MEMBER') u.role = 'MANAGER';
    if (manages) u.teamId = manages.id;
    if (!manages && u.role === 'MANAGER') u.role = 'MEMBER';
  }
  for (const u of ctx.db.users) {
    if (u.role === 'ADMIN' || u.provisioningStatus === 'PENDING') continue;
    const team = ctx.db.teams.find((t) => t.id === u.teamId);
    const managerId = team?.managerIds.find((id) => id !== u.id);
    u.managerId = managerId ?? ctx.db.users.find((x) => x.role === 'ADMIN' && isActive(x))?.id ?? null;
  }
}

// ---------------------------------------------------------------------------
// Monitoring settings
// ---------------------------------------------------------------------------

function effectiveInterval(ctx: Ctx, u: DbUser): 1 | 2 | 3 {
  return u.screenshotIntervalMin ?? ctx.db.workspacePolicy.defaultScreenshotIntervalMin;
}

function memberSettings(ctx: Ctx, u: DbUser): TeamMemberSettingsDto {
  const team = ctx.empty ? undefined : ctx.db.teams.find((t) => t.id === u.teamId);
  const manager = managerOf(ctx, u);
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    avatarUrl: u.avatarUrl,
    role: u.role,
    team: team ? { id: team.id, name: team.name } : null,
    manager: manager ? person(manager) : null,
    shiftId: ctx.empty ? null : u.shiftId,
    shiftAssignedAt: ctx.empty || u.shiftAssignedAt === null ? null : iso(u.shiftAssignedAt),
    screenshotIntervalMin: effectiveInterval(ctx, u),
    idleThresholdMin: u.idleThresholdMin ?? ctx.db.workspacePolicy.defaultIdleThresholdMin ?? MEMBER_SETTING_DEFAULTS.idleThresholdMin,
    idleWarningSeconds: u.idleWarningSeconds,
    attendanceRuleMode: u.attendanceRuleMode ?? 'STANDARD',
    createdAt: iso(u.createdAt),
  };
}

export function riskOf(shots: number, idle: number): 'NORMAL' | 'CAUTION' | 'HIGH' {
  if (shots === 1 || idle === 1) return 'HIGH';
  if (shots === 2 || idle <= 3) return 'CAUTION';
  return 'NORMAL';
}

export function registerPeople(): void {
  get('/v1/admin/users', (req, ctx) => {
    const includeDeactivated = ctx.me.role === 'ADMIN' && req.query.get('includeDeactivated') === 'true';
    const pendingOnly = ctx.me.role === 'ADMIN' && req.query.get('status') === 'pending';
    let users = scopeUsers(ctx, { includeDeactivated });
    if (pendingOnly) users = users.filter((u) => u.provisioningStatus === 'PENDING');
    return { users: sortUsers(users).map((u) => adminUser(ctx, u)), scope: scopeKind(ctx) };
  });

  post('/v1/admin/users', (req, ctx) => {
    requireAdmin(ctx);
    const b = bodyObject(req);
    const email = str(b.email)?.trim().toLowerCase();
    const name = str(b.name)?.trim();
    if (!email || !email.includes('@')) fail(400, 'invalid_email');
    if (!name) fail(400, 'invalid_name');
    if (ctx.db.users.some((u) => u.email.toLowerCase() === email)) fail(409, 'email_taken');
    const role = (str(b.role) as Role | undefined) ?? 'MEMBER';
    const id = newId('usr');
    const u: DbUser = {
      id,
      name: name!,
      email: email!,
      role: role === 'MANAGER' ? 'MEMBER' : role,
      activityRoleTitle: 'OTHER',
      teamId: null,
      managerId: ctx.db.users.find((x) => x.role === 'ADMIN')?.id ?? null,
      avatarUrl: null,
      shiftId: null,
      shiftAssignedAt: null,
      createdAt: ctx.now,
      birthDate: null,
      deactivatedAt: null,
      provisioningStatus: 'ACTIVE',
      persona: 'steady',
      discipline: 'ops',
      agent: { platform: null, version: null, screen: null, accessibilityTrusted: null, accessibilityReady: null, hookRunning: null, launch: null, origin: null },
      screenshotIntervalMin: null,
      idleThresholdMin: null,
      idleWarningSeconds: null,
      leaveAccrualDays: null,
      leaveLastSaturdayOff: null,
      joinedOn: todayKey(),
    };
    ctx.db.users.push(u);
    persist();
    return withStatus(201, adminUser(ctx, u));
  });

  patch('/v1/admin/users/:id', (req, ctx) => {
    requireAdmin(ctx);
    const u = requireUser(ctx, req.params.id);
    const b = bodyObject(req);
    if (typeof b.name === 'string' && b.name.trim()) u.name = b.name.trim();
    if (typeof b.role === 'string' && (b.role === 'ADMIN' || b.role === 'MEMBER')) {
      if (u.id === ctx.me.id && b.role !== 'ADMIN') fail(400, 'cannot_demote_self');
      u.role = b.role;
      if (b.role === 'ADMIN') for (const t of ctx.db.teams) t.managerIds = t.managerIds.filter((id) => id !== u.id);
    }
    if (b.teamId !== undefined) {
      const teamId = str(b.teamId) ?? null;
      if (teamId && !ctx.db.teams.some((t) => t.id === teamId)) fail(400, 'invalid_team');
      if (ctx.db.teams.some((t) => t.managerIds.includes(u.id) && t.id !== teamId)) fail(409, 'remove_team_manager_first');
      u.teamId = teamId;
    }
    if (b.shiftId !== undefined) {
      const shiftId = str(b.shiftId) ?? null;
      if (shiftId && !ctx.db.shifts.some((s) => s.id === shiftId)) fail(400, 'invalid_shift');
      u.shiftId = shiftId;
      u.shiftAssignedAt = shiftId ? ctx.now : null;
    }
    if (b.birthDate !== undefined) {
      const bd = str(b.birthDate) ?? null;
      if (bd !== null && !/^\d{4}-\d{2}-\d{2}$/.test(bd)) fail(400, 'invalid_birth_date');
      u.birthDate = bd;
    }
    syncManagers(ctx);
    persist();
    return adminUser(ctx, u);
  });

  post('/v1/admin/users/:id/deactivate', (req, ctx) => {
    requireAdmin(ctx);
    const u = requireUser(ctx, req.params.id);
    if (u.id === ctx.me.id) fail(400, 'cannot_deactivate_self');
    if (ctx.db.teams.some((t) => t.managerIds.includes(u.id))) fail(409, 'remove_team_manager_first');
    u.deactivatedAt = ctx.now;
    persist();
    return { id: u.id, deactivatedAt: iso(u.deactivatedAt) };
  });

  post('/v1/admin/users/:id/reactivate', (req, ctx) => {
    requireAdmin(ctx);
    const u = requireUser(ctx, req.params.id);
    u.deactivatedAt = null;
    persist();
    return { id: u.id, deactivatedAt: null };
  });

  post('/v1/admin/users/:id/activate', (req, ctx) => {
    requireAdmin(ctx);
    const u = requireUser(ctx, req.params.id);
    u.provisioningStatus = 'ACTIVE';
    if (!u.avatarUrl) u.avatarUrl = avatarDataUrl(u.id);
    persist();
    return { id: u.id, provisioningStatus: 'ACTIVE' as const };
  });

  get('/v1/admin/users/:id/deletion-plan', (req, ctx) => {
    requireAdmin(ctx);
    const u = requireUser(ctx, req.params.id);
    if (u.id === ctx.me.id) fail(400, 'cannot_delete_self');
    const managed = ctx.db.teams.find((t) => t.managerIds.includes(u.id));
    if (managed) fail(400, 'remove_team_manager_first', { teamName: managed.name });
    return deletionPlan(ctx, u);
  });

  del('/v1/admin/users/:id', (req, ctx) => {
    requireAdmin(ctx);
    const u = requireUser(ctx, req.params.id);
    const b = bodyObject(req);
    if (str(b.confirmEmail)?.trim().toLowerCase() !== u.email.toLowerCase()) fail(400, 'confirm_email_mismatch');
    if (u.id === ctx.me.id) fail(400, 'cannot_delete_self');
    const db = ctx.db;
    db.users = db.users.filter((x) => x.id !== u.id);
    db.requests = db.requests.filter((r) => r.userId !== u.id).map((r) => (r.approverId === u.id ? { ...r, approverId: null } : r));
    db.manualEntries = db.manualEntries.filter((m) => m.userId !== u.id);
    db.flags = db.flags.filter((f) => f.userId !== u.id);
    db.leaveRequests = db.leaveRequests.filter((l) => l.userId !== u.id);
    db.overrides = db.overrides.filter((o) => o.userId !== u.id);
    persist();
    return { ok: true };
  });

  // ---- Teams ---------------------------------------------------------------

  get('/v1/admin/teams', (_req, ctx) => {
    requireCap(ctx, 'teams.read');
    if (ctx.empty) return { teams: [] };
    return { teams: [...ctx.db.teams].sort((a, b) => a.name.localeCompare(b.name)).map((t) => teamDto(ctx, t.id)) };
  });

  post('/v1/admin/teams', (req, ctx) => {
    requireAdmin(ctx);
    const b = bodyObject(req);
    const name = str(b.name)?.trim() ?? '';
    if (!name || name.length > 80) fail(400, 'invalid_name');
    if (ctx.db.teams.some((t) => t.name.toLowerCase() === name.toLowerCase())) fail(409, 'team_name_taken');
    const managerIds = Array.isArray(b.managerIds) ? b.managerIds.filter((x): x is string => typeof x === 'string') : [];
    if (managerIds.some((id) => ctx.db.teams.some((t) => t.managerIds.includes(id)))) fail(409, 'manager_already_assigned');
    const id = newId('team');
    ctx.db.teams.push({ id, name, managerIds, createdAt: ctx.now });
    syncManagers(ctx);
    persist();
    return withStatus(201, teamDto(ctx, id));
  });

  patch('/v1/admin/teams/:id', (req, ctx) => {
    requireAdmin(ctx);
    const t = ctx.db.teams.find((x) => x.id === req.params.id);
    if (!t) return fail(404, 'not_found');
    const b = bodyObject(req);
    if (b.name !== undefined) {
      const name = str(b.name)?.trim() ?? '';
      if (!name || name.length > 80) fail(400, 'invalid_name');
      t.name = name;
    }
    if (Array.isArray(b.managerIds)) {
      const ids = b.managerIds.filter((x): x is string => typeof x === 'string');
      if (ids.some((id) => ctx.db.teams.some((o) => o.id !== t.id && o.managerIds.includes(id)))) fail(409, 'manager_already_assigned');
      t.managerIds = ids;
    }
    syncManagers(ctx);
    persist();
    return teamDto(ctx, t.id);
  });

  del('/v1/admin/teams/:id', (req, ctx) => {
    requireAdmin(ctx);
    const t = ctx.db.teams.find((x) => x.id === req.params.id);
    if (!t) return fail(404, 'not_found');
    ctx.db.teams = ctx.db.teams.filter((x) => x.id !== t.id);
    for (const u of ctx.db.users) if (u.teamId === t.id) u.teamId = null;
    syncManagers(ctx);
    persist();
    return { ok: true };
  });

  post('/v1/admin/teams/:id/managers', (req, ctx) => {
    requireAdmin(ctx);
    const t = ctx.db.teams.find((x) => x.id === req.params.id);
    if (!t) return fail(404, 'not_found');
    const userId = str(bodyObject(req).userId);
    if (!userId) fail(400, 'manager_required');
    const u = requireUser(ctx, userId);
    if (u.role === 'ADMIN') fail(400, 'admin_cannot_manage_team');
    if (ctx.db.teams.some((o) => o.id !== t.id && o.managerIds.includes(u.id))) fail(409, 'manager_already_assigned');
    if (!t.managerIds.includes(u.id)) t.managerIds.push(u.id);
    syncManagers(ctx);
    persist();
    return withStatus(201, teamDto(ctx, t.id));
  });

  del('/v1/admin/teams/:id/managers/:userId', (req, ctx) => {
    requireAdmin(ctx);
    const t = ctx.db.teams.find((x) => x.id === req.params.id);
    if (!t) return fail(404, 'not_found');
    t.managerIds = t.managerIds.filter((id) => id !== req.params.userId);
    syncManagers(ctx);
    persist();
    return teamDto(ctx, t.id);
  });

  // ---- Shifts --------------------------------------------------------------

  get('/v1/admin/shifts', (_req, ctx) => {
    requireCap(ctx, 'shifts.read');
    if (ctx.empty) return { shifts: [] };
    return { shifts: ctx.db.shifts.map((s) => shiftDto(ctx, s)) };
  });

  post('/v1/admin/shifts', (req, ctx) => {
    requireAdmin(ctx);
    const b = bodyObject(req);
    const name = str(b.name)?.trim();
    if (!name) fail(400, 'invalid_name');
    const id = newId('shf');
    const s = { id, name: name!, schedule: b.schedule as ShiftSchedule, bufferMin: typeof b.bufferMin === 'number' ? b.bufferMin : 30, createdAt: ctx.now, updatedAt: ctx.now };
    ctx.db.shifts.push(s);
    persist();
    return withStatus(201, shiftDto(ctx, s));
  });

  patch('/v1/admin/shifts/:id', (req, ctx) => {
    requireAdmin(ctx);
    const s = ctx.db.shifts.find((x) => x.id === req.params.id);
    if (!s) return fail(404, 'not_found');
    const b = bodyObject(req);
    if (typeof b.name === 'string' && b.name.trim()) s.name = b.name.trim();
    if (b.schedule && typeof b.schedule === 'object') s.schedule = b.schedule as ShiftSchedule;
    if (typeof b.bufferMin === 'number') s.bufferMin = b.bufferMin;
    s.updatedAt = ctx.now;
    persist();
    return shiftDto(ctx, s);
  });

  del('/v1/admin/shifts/:id', (req, ctx) => {
    requireAdmin(ctx);
    const s = ctx.db.shifts.find((x) => x.id === req.params.id);
    if (!s) return fail(404, 'not_found');
    ctx.db.shifts = ctx.db.shifts.filter((x) => x.id !== s.id);
    for (const u of ctx.db.users) {
      if (u.shiftId === s.id) {
        u.shiftId = null;
        u.shiftAssignedAt = null;
      }
    }
    persist();
    return { ok: true };
  });

  // ---- Per-member monitoring settings --------------------------------------

  get('/v1/admin/team-member-settings', (_req, ctx): TeamSettingsResponse => {
    requireCap(ctx, 'team.settings.manage');
    const members = scopeUsers(ctx).filter((u) => u.provisioningStatus === 'ACTIVE');
    return {
      scope: ctx.me.role === 'ADMIN' ? 'workspace' : 'team',
      members: sortUsers(members).map((u) => memberSettings(ctx, u)),
      shifts: ctx.empty ? [] : ctx.db.shifts.map((s) => shiftDto(ctx, s)),
    };
  });

  patch('/v1/admin/team-member-settings/:id', (req, ctx) => {
    requireCap(ctx, 'team.settings.manage');
    const u = requireUser(ctx, req.params.id);
    if (!scopeUsers(ctx).some((x) => x.id === u.id)) fail(403, 'forbidden');
    if (ctx.me.role !== 'ADMIN' && u.role === 'ADMIN') fail(403, 'forbidden');
    const b = bodyObject(req);
    const before = { shots: effectiveInterval(ctx, u), idle: u.idleThresholdMin ?? ctx.db.workspacePolicy.defaultIdleThresholdMin, warn: u.idleWarningSeconds };
    if (b.shiftId !== undefined) {
      u.shiftId = str(b.shiftId) ?? null;
      u.shiftAssignedAt = u.shiftId ? ctx.now : null;
    }
    if (b.screenshotIntervalMin !== undefined) u.screenshotIntervalMin = b.screenshotIntervalMin === null ? null : (Number(b.screenshotIntervalMin) as 1 | 2 | 3);
    if (b.idleThresholdMin !== undefined) u.idleThresholdMin = b.idleThresholdMin === null ? null : Number(b.idleThresholdMin);
    if (b.idleWarningSeconds !== undefined) u.idleWarningSeconds = b.idleWarningSeconds === null ? null : Number(b.idleWarningSeconds);
    if (b.attendanceRuleMode === 'STANDARD' || b.attendanceRuleMode === 'REMOTE' || b.attendanceRuleMode === 'EXEMPT') u.attendanceRuleMode = b.attendanceRuleMode;
    const after = { shots: effectiveInterval(ctx, u), idle: u.idleThresholdMin ?? ctx.db.workspacePolicy.defaultIdleThresholdMin, warn: u.idleWarningSeconds };
    const risk = riskOf(after.shots, after.idle);
    const reason = str(b.auditReason)?.trim() || null;
    if ((before.shots !== after.shots || before.idle !== after.idle) && risk === 'HIGH' && !reason) fail(400, 'missing_monitoring_audit_reason');
    if (before.shots !== after.shots || before.idle !== after.idle || before.warn !== after.warn) {
      ctx.db.audits.push({
        id: newId('aud'),
        scope: 'MEMBER_OVERRIDE',
        riskLevel: risk,
        actorId: ctx.me.id,
        targetUserId: u.id,
        previousScreenshotIntervalMin: before.shots,
        previousIdleThresholdMin: before.idle,
        previousIdleWarningSeconds: before.warn,
        nextScreenshotIntervalMin: after.shots,
        nextIdleThresholdMin: after.idle,
        nextIdleWarningSeconds: after.warn,
        reason,
        createdAt: ctx.now,
      });
    }
    persist();
    return memberSettings(ctx, u);
  });

}
