import { Router, type Request } from 'express';
import { prisma, type Prisma } from '@grind/db';
import { requireAccessToken } from '../middleware/auth';
import { attachScope, requireAdmin, requireAnyCapability, requireCapability, requireManagerOrAbove } from '../middleware/scope';
import { decideByUser } from '../lark/decideByUser';
import { triageRequest, type TriageResult } from '../ai/triage';
import { explainFlag } from '../ai/explainFlag';
import { resolveReportRange } from '../reports/member';
import {
  addDays as addDaysStr,
  buildTimesheetMatrix,
  dateRange,
  type TimesheetMatrix,
  type TimesheetSegmentInput,
} from '../insights/timesheets';
import { localDayWindow } from '../insights/day';
import {
  groupInvalidationsByUser,
  isInvalidatedAt,
  invalidatedOverlapMs,
  type TimeInvalidationInput,
} from '../insights/invalidations';
import { loadTimeInvalidationsForUsers } from '../insights/timeInvalidations';
import {
  CreateShiftSchema,
  PatchShiftSchema,
  PatchTeamMemberSettingsRequest,
  ShiftScheduleSchema,
  WORKSPACE_POLICY_DEFAULTS,
  normalizeScreenshotIntervalMin,
  type MonitoringSettingsAuditDto,
  type TeamMemberSettingsDto,
  type TeamSettingsResponse,
  type ShiftDto,
  type ShiftSchedule,
} from '@grind/types';
import {
  monitoringRiskLevel,
  monitoringTimingChanged,
  normalizeAuditReason,
} from '../monitoringSettingsAudit';
import {
  addTeamManager,
  assignUserToTeam,
  deleteTeam,
  normalizeManagerIds,
  removeTeamManager,
  replaceTeamManagers,
  type OrgMutationResult,
} from '../org/teamManagers';

/**
 * Mounted under `/v1/admin`. Every route requires a valid access token and
 * the resolved scope (self / team / workspace). Routes are intentionally
 * scope-aware: a MEMBER hitting `/v1/admin/users` gets their own row;
 * a MANAGER gets their team; ADMIN gets the whole workspace.
 */
export const adminRouter = Router();
adminRouter.use(requireAccessToken, attachScope);

interface UserListEntry {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: 'ADMIN' | 'MANAGER' | 'MEMBER';
  activityRoleTitle: 'DEVELOPER' | 'DESIGNER' | 'SALES' | 'OTHER';
  teamId: string | null;
  managerId: string | null;
  managesTeamId: string | null;
  managesTeamName: string | null;
  shiftId: string | null;
  deactivatedAt: string | null;
  provisioningStatus: 'PENDING' | 'ACTIVE';
  createdAt: string;
}

/**
 * GET /v1/admin/users — every user the caller is allowed to see, including
 * the caller themselves. Order: managers + admins first (for the dashboard
 * "People" table), then by name.
 *
 * Deactivated users are EXCLUDED by default (they're not in the scope's
 * userIds). ADMIN can pass ?includeDeactivated=true to see them — needed
 * so the dashboard can render the People list with a Reactivate button.
 */
adminRouter.get('/users', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const includeDeactivated =
      req.scope.isAdmin && req.query.includeDeactivated === 'true';
    // ?status=pending → the admin "Needs setup" view (Lark-provisioned users
    // awaiting a team/role + activation).
    const pendingOnly = req.scope.isAdmin && req.query.status === 'pending';

    const where = {
      ...(includeDeactivated ? { workspaceId: req.scope.workspaceId } : { id: { in: req.scope.userIds } }),
      ...(pendingOnly ? { provisioningStatus: 'PENDING' as const } : {}),
    };

    const users = await prisma.user.findMany({
      where,
      select: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        role: true,
        activityRoleTitle: true,
        teamId: true,
        managerId: true,
        managedTeamAssignment: { select: { teamId: true, team: { select: { name: true } } } },
        shiftId: true,
        deactivatedAt: true,
        provisioningStatus: true,
        createdAt: true,
      },
      orderBy: [{ deactivatedAt: 'asc' }, { role: 'asc' }, { name: 'asc' }],
    });
    const out: UserListEntry[] = users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      avatarUrl: u.avatarUrl,
      role: u.role,
      activityRoleTitle: u.activityRoleTitle,
      teamId: u.teamId,
      managerId: u.managerId,
      managesTeamId: u.managedTeamAssignment?.teamId ?? null,
      managesTeamName: u.managedTeamAssignment?.team.name ?? null,
      shiftId: u.shiftId,
      deactivatedAt: u.deactivatedAt ? u.deactivatedAt.toISOString() : null,
      provisioningStatus: u.provisioningStatus,
      createdAt: u.createdAt.toISOString(),
    }));
    res.json({ users: out, scope: req.scope.scope });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Team member tracking settings (MANAGER scoped, ADMIN workspace scoped)
// ============================================================================

type TeamSettingsUserRow = {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  role: 'ADMIN' | 'MANAGER' | 'MEMBER';
  teamId: string | null;
  managerId: string | null;
  shiftId: string | null;
  shiftAssignedAt: Date | null;
  // NULL = inherit the workspace policy default (resolved below).
  screenshotIntervalMin: number | null;
  idleThresholdMin: number | null;
  createdAt: Date;
  team: {
    id: string;
    name: string;
    managers: Array<{ user: { id: string; name: string; email: string; avatarUrl: string | null } }>;
  } | null;
};

/** Effective capture defaults for a workspace (per-member NULLs fall back here). */
type PolicyDefaults = { screenshotIntervalMin: number; idleThresholdMin: number };

async function loadPolicyDefaults(workspaceId: string): Promise<PolicyDefaults> {
  const policy = await prisma.workspacePolicy.findUnique({
    where: { workspaceId },
    select: { defaultScreenshotIntervalMin: true, defaultIdleThresholdMin: true },
  });
  return {
    screenshotIntervalMin: normalizeScreenshotIntervalMin(
      policy?.defaultScreenshotIntervalMin,
      WORKSPACE_POLICY_DEFAULTS.defaultScreenshotIntervalMin,
    ),
    idleThresholdMin: policy?.defaultIdleThresholdMin ?? WORKSPACE_POLICY_DEFAULTS.defaultIdleThresholdMin,
  };
}

function serializeTeamSettingsMember(
  user: TeamSettingsUserRow,
  manager: { id: string; name: string; email: string; avatarUrl: string | null } | null,
  defaults: PolicyDefaults,
): TeamMemberSettingsDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    role: user.role,
    team: user.team ? { id: user.team.id, name: user.team.name } : null,
    manager,
    shiftId: user.shiftId,
    shiftAssignedAt: user.shiftAssignedAt ? user.shiftAssignedAt.toISOString() : null,
    // Resolved effective values: per-member override → policy default.
    screenshotIntervalMin: normalizeScreenshotIntervalMin(user.screenshotIntervalMin, defaults.screenshotIntervalMin),
    idleThresholdMin: user.idleThresholdMin ?? defaults.idleThresholdMin,
    createdAt: user.createdAt.toISOString(),
  };
}

async function loadTeamSettingsMembers(userIds: string[]): Promise<TeamMemberSettingsDto[]> {
  if (userIds.length === 0) return [];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, deactivatedAt: null },
    select: {
      id: true,
      email: true,
      name: true,
      avatarUrl: true,
      role: true,
      teamId: true,
      managerId: true,
      shiftId: true,
      shiftAssignedAt: true,
      screenshotIntervalMin: true,
      idleThresholdMin: true,
      createdAt: true,
      workspaceId: true,
      team: {
        select: {
          id: true,
          name: true,
          managers: {
            orderBy: { createdAt: 'asc' },
            select: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } },
          },
        },
      },
    },
    orderBy: [{ teamId: 'asc' }, { role: 'asc' }, { name: 'asc' }],
  });

  // All members share one workspace (scope is workspace-bounded); resolve its
  // policy defaults once so per-member NULL overrides fall back to them.
  const workspaceId = users[0]?.workspaceId;
  const defaults = workspaceId ? await loadPolicyDefaults(workspaceId) : {
    screenshotIntervalMin: WORKSPACE_POLICY_DEFAULTS.defaultScreenshotIntervalMin,
    idleThresholdMin: WORKSPACE_POLICY_DEFAULTS.defaultIdleThresholdMin,
  };

  return users.map((u) =>
    serializeTeamSettingsMember(
      u,
      u.team?.managers.find((m) => m.user.id !== u.id)?.user ?? u.team?.managers[0]?.user ?? null,
      defaults,
    ),
  );
}

function scopedTeamSettingIds(req: Request): string[] {
  if (!req.scope || !req.user) return [];
  return req.scope.userIds;
}

adminRouter.get('/team-member-settings', requireCapability('team.settings.manage'), async (req, res, next) => {
  try {
    if (!req.scope || !req.user) return res.status(401).json({ error: 'unauthorized' });
    const [members, shifts] = await Promise.all([
      loadTeamSettingsMembers(scopedTeamSettingIds(req)),
      prisma.shift.findMany({
        where: { workspaceId: req.scope.workspaceId },
        include: { members: { select: { id: true } } },
        orderBy: { name: 'asc' },
      }),
    ]);
    const response: TeamSettingsResponse = {
      scope: req.scope.scope === 'workspace' ? 'workspace' : 'team',
      members,
      shifts: shifts.map(serializeShift),
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/team-member-settings/:id', requireCapability('team.settings.manage'), async (req, res, next) => {
  try {
    if (!req.scope || !req.user) return res.status(401).json({ error: 'unauthorized' });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing_id' });
    if (!scopedTeamSettingIds(req).includes(id)) {
      return res.status(404).json({ error: 'not_found' });
    }
    if (!req.scope.isAdmin && id === req.user.sub) {
      return res.status(403).json({ error: 'self_settings_forbidden' });
    }

    const parsed = PatchTeamMemberSettingsRequest.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_body', detail: parsed.error.format() });
    }

    const existing = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        workspaceId: true,
        teamId: true,
        shiftId: true,
        screenshotIntervalMin: true,
        idleThresholdMin: true,
        provisioningStatus: true,
        deactivatedAt: true,
      },
    });
    if (!existing || existing.workspaceId !== req.scope.workspaceId || existing.deactivatedAt) {
      return res.status(404).json({ error: 'not_found' });
    }

    const defaults = await loadPolicyDefaults(req.scope.workspaceId);
    const previousTiming = {
      screenshotIntervalMin: existing.screenshotIntervalMin ?? defaults.screenshotIntervalMin,
      idleThresholdMin: existing.idleThresholdMin ?? defaults.idleThresholdMin,
    };
    const nextTiming = {
      screenshotIntervalMin:
        parsed.data.screenshotIntervalMin !== undefined
          ? parsed.data.screenshotIntervalMin ?? defaults.screenshotIntervalMin
          : previousTiming.screenshotIntervalMin,
      idleThresholdMin:
        parsed.data.idleThresholdMin !== undefined
          ? parsed.data.idleThresholdMin ?? defaults.idleThresholdMin
          : previousTiming.idleThresholdMin,
    };
    const timingChanged = monitoringTimingChanged(previousTiming, nextTiming);
    const riskLevel = monitoringRiskLevel(nextTiming);
    const auditReason = normalizeAuditReason(parsed.data.auditReason);
    if (timingChanged && riskLevel === 'HIGH' && !auditReason) {
      return res.status(400).json({ error: 'missing_monitoring_audit_reason' });
    }

    const data: {
      shiftId?: string | null;
      shiftAssignedAt?: Date | null;
      // null clears the per-member override → inherit policy.
      screenshotIntervalMin?: number | null;
      idleThresholdMin?: number | null;
      provisioningStatus?: 'ACTIVE';
    } = {};
    let shiftAssignment:
      | {
          effectiveFrom: Date;
          shiftId: string | null;
          shiftNameSnapshot: string | null;
          scheduleSnapshot: Prisma.InputJsonValue | null;
          bufferMinSnapshot: number | null;
        }
      | null = null;

    if (parsed.data.screenshotIntervalMin !== undefined) {
      data.screenshotIntervalMin = parsed.data.screenshotIntervalMin;
    }
    if (parsed.data.idleThresholdMin !== undefined) {
      data.idleThresholdMin = parsed.data.idleThresholdMin;
    }
    if ('shiftId' in parsed.data) {
      const raw = parsed.data.shiftId;
      const effectiveFrom = new Date();
      if (raw === null || raw === '') {
        if (existing.shiftId !== null) {
          data.shiftId = null;
          data.shiftAssignedAt = null;
          shiftAssignment = {
            effectiveFrom,
            shiftId: null,
            shiftNameSnapshot: null,
            scheduleSnapshot: null,
            bufferMinSnapshot: null,
          };
        }
      } else if (typeof raw === 'string') {
        const s = await prisma.shift.findUnique({
          where: { id: raw },
          select: { workspaceId: true, name: true, schedule: true, bufferMin: true },
        });
        if (!s || s.workspaceId !== req.scope.workspaceId) {
          return res.status(400).json({ error: 'shift_out_of_workspace' });
        }
        if (existing.shiftId !== raw) {
          data.shiftId = raw;
          data.shiftAssignedAt = effectiveFrom;
          shiftAssignment = {
            effectiveFrom,
            shiftId: raw,
            shiftNameSnapshot: s.name,
            scheduleSnapshot: s.schedule,
            bufferMinSnapshot: s.bufferMin,
          };
        }
      }
    }

    if (
      req.scope.isAdmin &&
      existing.provisioningStatus === 'PENDING' &&
      hasCompletedMemberSetup({
        teamId: existing.teamId,
        shiftId: data.shiftId !== undefined ? data.shiftId : existing.shiftId,
      })
    ) {
      data.provisioningStatus = 'ACTIVE';
    }

    if (Object.keys(data).length > 0) {
      await prisma.$transaction(async (tx) => {
        if (shiftAssignment) {
          await tx.shiftAssignment.updateMany({
            where: { userId: id, effectiveTo: null },
            data: { effectiveTo: shiftAssignment.effectiveFrom },
          });
          await tx.shiftAssignment.create({
            data: {
              userId: id,
              shiftId: shiftAssignment.shiftId,
              effectiveFrom: shiftAssignment.effectiveFrom,
              shiftNameSnapshot: shiftAssignment.shiftNameSnapshot,
              bufferMinSnapshot: shiftAssignment.bufferMinSnapshot,
              ...(shiftAssignment.scheduleSnapshot === null ? {} : { scheduleSnapshot: shiftAssignment.scheduleSnapshot }),
            },
          });
        }
        await tx.user.update({ where: { id }, data });
        if (timingChanged) {
          await tx.monitoringSettingsAudit.create({
            data: {
              workspaceId: req.scope!.workspaceId,
              actorId: req.user!.sub,
              targetUserId: id,
              scope: 'MEMBER_OVERRIDE',
              previousScreenshotIntervalMin: previousTiming.screenshotIntervalMin,
              previousIdleThresholdMin: previousTiming.idleThresholdMin,
              nextScreenshotIntervalMin: nextTiming.screenshotIntervalMin,
              nextIdleThresholdMin: nextTiming.idleThresholdMin,
              riskLevel,
              reason: auditReason,
            },
          });
        }
      });
    }

    const [member] = await loadTeamSettingsMembers([id]);
    if (!member) return res.status(404).json({ error: 'not_found' });
    res.json(member);
  } catch (err) {
    next(err);
  }
});

type MonitoringSettingsAuditRow = {
  id: string;
  scope: 'WORKSPACE_POLICY' | 'MEMBER_OVERRIDE';
  riskLevel: 'NORMAL' | 'CAUTION' | 'HIGH';
  previousScreenshotIntervalMin: number | null;
  previousIdleThresholdMin: number | null;
  nextScreenshotIntervalMin: number | null;
  nextIdleThresholdMin: number | null;
  reason: string | null;
  createdAt: Date;
  actor: { id: string; name: string; email: string } | null;
  targetUser: { id: string; name: string; email: string } | null;
};

function serializeMonitoringSettingsAudit(row: MonitoringSettingsAuditRow): MonitoringSettingsAuditDto {
  return {
    id: row.id,
    scope: row.scope,
    riskLevel: row.riskLevel,
    actor: row.actor,
    targetUser: row.targetUser,
    previousScreenshotIntervalMin: row.previousScreenshotIntervalMin,
    previousIdleThresholdMin: row.previousIdleThresholdMin,
    nextScreenshotIntervalMin: row.nextScreenshotIntervalMin,
    nextIdleThresholdMin: row.nextIdleThresholdMin,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

adminRouter.get('/monitoring-settings-audits', requireCapability('policy.manage'), async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const rawLimit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 100;
    const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, rawLimit)) : 100;
    const rows = await prisma.monitoringSettingsAudit.findMany({
      where: { workspaceId: req.scope.workspaceId },
      include: {
        actor: { select: { id: true, name: true, email: true } },
        targetUser: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    res.json({ audits: rows.map(serializeMonitoringSettingsAudit) });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Manual-time approvals queue (MANAGER and above)
// ============================================================================

interface MtrListEntry {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  version: number;
  larkDeliveryStatus: 'none' | 'queued' | 'sent' | 'retrying' | 'failed';
  latestLarkMessageStatus: string | null;
  requestedStart: string;
  requestedEnd: string;
  reason: string;
  larkTaskGuid: string | null;
  taskSummary: string | null;
  decidedAt: string | null;
  decidedReason: string | null;
  createdAt: string;
  user: { id: string; name: string; email: string };
  approver: { id: string; name: string; email: string } | null;
  /** AI-assist verdict + reasons (PENDING only — set to null otherwise). */
  triage: TriageResult | null;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** UTC day-start (midnight) for a given timestamp — used by triage's adjacency window. */
function dayStartMs(d: Date): number {
  const t = d.getTime();
  return t - (t % (24 * 60 * 60 * 1000));
}

/**
 * Compute per-user 30-day approval / rejection / daily-average context
 * in a single batched DB pass. Used to enrich PENDING rows with triage.
 */
async function buildTriageContextByUser(userIds: string[], now: number) {
  if (userIds.length === 0) {
    return new Map<string, { avgDailyTotalMs: number; approved: number; rejected: number }>();
  }
  const since = new Date(now - THIRTY_DAYS_MS);

  // Approval + rejection counts (one round-trip per status — Prisma's
  // groupBy returns one row per (userId, status) combo).
  const counts = await prisma.manualTimeRequest.groupBy({
    by: ['userId', 'status'],
    where: { userId: { in: userIds }, createdAt: { gte: since } },
    _count: { _all: true },
  });

  // Trailing-30-day TOTAL AUTO + MANUAL tracked ms per user. Heuristic:
  // sum segment durations directly; segment.endedAt may be null for
  // an open entry but we clamp to `now`.
  const segments = await prisma.timeSegment.findMany({
    where: {
      timeEntry: { userId: { in: userIds } },
      startedAt: { gte: since },
    },
    select: {
      startedAt: true,
      endedAt: true,
      timeEntry: { select: { userId: true } },
    },
  });
  const totalByUser = new Map<string, number>();
  for (const s of segments) {
    const end = (s.endedAt ?? new Date(now)).getTime();
    const dur = Math.max(0, end - s.startedAt.getTime());
    const uid = s.timeEntry.userId;
    totalByUser.set(uid, (totalByUser.get(uid) ?? 0) + dur);
  }

  const out = new Map<string, { avgDailyTotalMs: number; approved: number; rejected: number }>();
  for (const uid of userIds) {
    const total = totalByUser.get(uid) ?? 0;
    const approved = counts
      .filter((c) => c.userId === uid && c.status === 'APPROVED')
      .reduce((n, c) => n + c._count._all, 0);
    const rejected = counts
      .filter((c) => c.userId === uid && c.status === 'REJECTED')
      .reduce((n, c) => n + c._count._all, 0);
    out.set(uid, {
      avgDailyTotalMs: total / 30,
      approved,
      rejected,
    });
  }
  return out;
}

/**
 * Per-request "same-day AUTO totals + closest-edge" computed against
 * a single user's segment list. Pure — the caller pre-fetches segments
 * once per (workspace, day window).
 */
function adjacencyFor(
  segments: Array<{ startedAt: number; endedAt: number; userId: string }>,
  userId: string,
  reqStart: number,
  reqEnd: number,
  dayStart: number,
  dayEnd: number,
): { autoTrackedSameDayMs: number; closestAutoEdgeMs: number } {
  let same = 0;
  let closest = Number.POSITIVE_INFINITY;
  for (const s of segments) {
    if (s.userId !== userId) continue;
    const a = Math.max(dayStart, s.startedAt);
    const b = Math.min(dayEnd, s.endedAt);
    if (b > a) same += b - a;
    // Distance from this segment to the request window (0 if overlapping).
    if (s.endedAt < reqStart) closest = Math.min(closest, reqStart - s.endedAt);
    else if (s.startedAt > reqEnd) closest = Math.min(closest, s.startedAt - reqEnd);
    else closest = 0;
  }
  return {
    autoTrackedSameDayMs: same,
    closestAutoEdgeMs: Number.isFinite(closest) ? closest : 24 * 60 * 60 * 1000,
  };
}

/**
 * GET /v1/admin/manual-time-requests
 *
 * Scoped queue of manual-time requests. MANAGER sees their team members';
 * ADMIN sees the whole workspace; MEMBERs get 403 (they have their
 * own self-view via /v1/time-requests).
 *
 * Filters:
 *   ?status=PENDING (default) — also accepts APPROVED, REJECTED, CANCELLED, all
 *
 * Sort: PENDING first (oldest pending bubbles up), then by createdAt desc.
 */
adminRouter.get('/manual-time-requests', requireManagerOrAbove, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const hasRange = req.query.from !== undefined || req.query.to !== undefined || req.query.tz !== undefined;
    const range = hasRange ? resolveReportRange(req.query as Record<string, unknown>) : null;
    if (range && 'error' in range) {
      return res.status(range.status).json({ error: range.error, ...(range.extras ?? {}) });
    }
    const statusParam = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : 'PENDING';
    const validStatuses = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
    const where: Prisma.ManualTimeRequestWhereInput = {
      userId: { in: req.scope.userIds },
      ...(range && !('error' in range)
        ? { requestedStart: { lt: range.rangeEnd }, requestedEnd: { gt: range.rangeStart } }
        : {}),
    };
    if (statusParam !== 'ALL') {
      if (!(validStatuses as readonly string[]).includes(statusParam)) {
        return res.status(400).json({ error: 'invalid_status' });
      }
      where.status = statusParam as (typeof validStatuses)[number];
    }
    const rows = await prisma.manualTimeRequest.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, email: true } },
        approver: { select: { id: true, name: true, email: true } },
        larkMessages: { select: { status: true, attempts: true, version: true, createdAt: true } },
      },
      orderBy: [
        // PENDING bubbles to the top of mixed queries via createdAt fallback.
        { createdAt: 'desc' },
      ],
      take: 200,
    });
    // Triage enrichment for PENDING rows only (decided rows already have
    // a verdict). Skips entirely if there are no PENDING rows — keeps
    // historical / decided-only queries cheap.
    const pendingRows = rows.filter((r) => r.status === 'PENDING');
    let triageByRequest: Map<string, TriageResult> | null = null;
    if (pendingRows.length > 0) {
      const now = Date.now();
      const userIds = Array.from(new Set(pendingRows.map((r) => r.userId)));
      const perUser = await buildTriageContextByUser(userIds, now);

      // One segments query per page-load for the pending-day windows.
      const earliestDay = pendingRows.reduce((min, r) => Math.min(min, dayStartMs(r.requestedStart)), Infinity);
      const latestDay = pendingRows.reduce((max, r) => Math.max(max, dayStartMs(r.requestedStart) + 24 * 3_600_000), 0);
      const segs = await prisma.timeSegment.findMany({
        where: {
          timeEntry: { userId: { in: userIds }, source: 'AUTO' },
          startedAt: { lt: new Date(latestDay) },
          OR: [{ endedAt: null }, { endedAt: { gt: new Date(earliestDay) } }],
        },
        select: {
          startedAt: true,
          endedAt: true,
          timeEntry: { select: { userId: true } },
        },
      });
      const segLite = segs.map((s) => ({
        startedAt: s.startedAt.getTime(),
        endedAt: (s.endedAt ?? new Date(now)).getTime(),
        userId: s.timeEntry.userId,
      }));

      triageByRequest = new Map<string, TriageResult>();
      for (const r of pendingRows) {
        const reqStart = r.requestedStart.getTime();
        const reqEnd = r.requestedEnd.getTime();
        const dayStart = dayStartMs(r.requestedStart);
        const adj = adjacencyFor(segLite, r.userId, reqStart, reqEnd, dayStart, dayStart + 24 * 3_600_000);
        const ctx = perUser.get(r.userId) ?? { avgDailyTotalMs: 0, approved: 0, rejected: 0 };
        const triage = triageRequest({
          requestedStartMs: reqStart,
          requestedEndMs: reqEnd,
          reason: r.reason,
          context: {
            autoTrackedSameDayMs: adj.autoTrackedSameDayMs,
            closestAutoEdgeMs: adj.closestAutoEdgeMs,
            avgDailyTotalMs: ctx.avgDailyTotalMs,
            rejectedLast30Days: ctx.rejected,
            approvedLast30Days: ctx.approved,
            requestAgeMs: Math.max(0, now - r.createdAt.getTime()),
          },
        });
        triageByRequest.set(r.id, triage);
      }
    }

    function deliveryFor(r: (typeof rows)[number]): Pick<MtrListEntry, 'larkDeliveryStatus' | 'latestLarkMessageStatus'> {
      const latest = r.larkMessages
        .slice()
        .sort((a, b) => b.version - a.version || b.createdAt.getTime() - a.createdAt.getTime())[0];
      if (!latest) return { larkDeliveryStatus: 'none', latestLarkMessageStatus: null };
      if (['SENT', 'DECIDED', 'CANCELLED', 'SUPERSEDED'].includes(latest.status)) {
        return { larkDeliveryStatus: 'sent', latestLarkMessageStatus: latest.status };
      }
      if (['SEND_FAILED', 'UPDATE_FAILED'].includes(latest.status)) {
        return { larkDeliveryStatus: latest.attempts >= 25 ? 'failed' : 'retrying', latestLarkMessageStatus: latest.status };
      }
      return { larkDeliveryStatus: 'queued', latestLarkMessageStatus: latest.status };
    }

    const out: MtrListEntry[] = rows.map((r) => ({
      id: r.id,
      status: r.status,
      version: r.version,
      ...deliveryFor(r),
      requestedStart: r.requestedStart.toISOString(),
      requestedEnd: r.requestedEnd.toISOString(),
      reason: r.reason,
      larkTaskGuid: r.larkTaskGuid,
      taskSummary: r.taskSummary,
      decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
      decidedReason: r.decidedReason,
      createdAt: r.createdAt.toISOString(),
      user: { id: r.user.id, name: r.user.name, email: r.user.email },
      approver: r.approver ? { id: r.approver.id, name: r.approver.name, email: r.approver.email } : null,
      triage: triageByRequest?.get(r.id) ?? null,
    }));
    res.json({
      requests: out,
      scope: req.scope.scope,
      ...(range && !('error' in range) ? { from: range.from, to: range.to, tz: range.tz } : {}),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /v1/admin/manual-time-requests/:id/decide
 * Body: { action: 'approve' | 'reject', reason?: string }
 *
 * Dashboard mirror of the Lark IM card flow. Same DB effects (status,
 * decidedAt, decidedReason, TimeEntry on approve). Best-effort refresh of
 * the Lark card so the approver chat matches DB truth.
 *
 * Authorization is enforced inside `decideByUser` by checking the requester's
 * userId is in `req.scope.userIds`. We block MEMBERs at the router level so
 * a MEMBER hitting this endpoint never even hits the service.
 */
adminRouter.post('/manual-time-requests/:id/decide', requireManagerOrAbove, async (req, res, next) => {
  try {
    if (!req.scope || !req.user) return res.status(401).json({ error: 'unauthorized' });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const action = typeof req.body?.action === 'string' ? req.body.action : '';
    if (action !== 'approve' && action !== 'reject') {
      return res.status(400).json({ error: 'invalid_action' });
    }
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) || undefined : undefined;
    const out = await decideByUser({
      requestId: id,
      action,
      deciderUserId: req.user.sub,
      deciderRole: req.user.role,
      scopeUserIds: req.scope.userIds,
      reason,
    });
    if (!out) return res.status(404).json({ error: 'not_found' });
    if (out.noop === 'forbidden') return res.status(403).json({ error: 'forbidden' });
    if (out.noop === 'self_approval_forbidden') return res.status(403).json({ error: 'self_approval_forbidden' });
    res.json(out);
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Timesheets matrix (MANAGER and above)
// ============================================================================

const TIMESHEETS_MAX_DAYS = 60;
const TIMESHEETS_DEFAULT_DAYS = 14;

function isYmd(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

interface ResolvedTimesheetRange {
  from: string;
  to: string;
  tz: string;
}

interface TimesheetRangeError {
  status: number;
  error: string;
  extras?: Record<string, unknown>;
}

/** Pull tz / from / to from the query and validate. Returns either a
 *  resolved range or the error shape the route should respond with. */
function resolveTimesheetRange(req: { query: Record<string, unknown> }): ResolvedTimesheetRange | TimesheetRangeError {
  const tz = typeof req.query.tz === 'string' && (req.query.tz as string).length > 0 ? (req.query.tz as string) : 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    return { status: 400, error: 'invalid_tz' };
  }
  const todayKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date())
    .slice(0, 10);

  const to = isYmd(req.query.to) ? (req.query.to as string) : todayKey;
  const from = isYmd(req.query.from) ? (req.query.from as string) : addDaysStr(to, -(TIMESHEETS_DEFAULT_DAYS - 1));

  if (from > to) return { status: 400, error: 'invalid_range' };
  const len = dateRange(from, to).length;
  if (len > TIMESHEETS_MAX_DAYS) {
    return { status: 400, error: 'range_too_long', extras: { maxDays: TIMESHEETS_MAX_DAYS } };
  }
  return { from, to, tz };
}

/** Build the matrix + the user list, used by both the JSON and CSV endpoints. */
async function loadTimesheetData(scope: { userIds: string[] }, range: ResolvedTimesheetRange) {
  const lookbackStart = new Date(`${range.from}T00:00:00Z`);
  lookbackStart.setUTCDate(lookbackStart.getUTCDate() - 1);
  const lookbackEnd = new Date(`${range.to}T00:00:00Z`);
  lookbackEnd.setUTCDate(lookbackEnd.getUTCDate() + 2);

  const [entries, invalidations] = await Promise.all([
    prisma.timeEntry.findMany({
      where: {
        userId: { in: scope.userIds },
        startedAt: { lt: lookbackEnd },
        OR: [{ endedAt: null }, { endedAt: { gt: lookbackStart } }],
      },
      include: { segments: { select: { kind: true, startedAt: true, endedAt: true } } },
    }),
    loadTimeInvalidationsForUsers(scope.userIds, lookbackStart, lookbackEnd),
  ]);

  const now = Date.now();
  const segs: TimesheetSegmentInput[] = [];
  for (const e of entries) {
    for (const s of e.segments) {
      segs.push({
        userId: e.userId,
        source: e.source as 'AUTO' | 'MANUAL',
        segmentKind: s.kind as 'WORK' | 'MEETING' | 'IDLE_TRIMMED',
        startedAt: s.startedAt.getTime(),
        endedAt: (s.endedAt ?? new Date(now)).getTime(),
      });
    }
  }

  const matrix = buildTimesheetMatrix({ from: range.from, to: range.to, tz: range.tz, segments: segs, invalidations });
  if (matrix) {
    const samples = await prisma.activitySample.findMany({
      where: {
        userId: { in: scope.userIds },
        bucketStart: { gte: lookbackStart, lt: lookbackEnd },
      },
      select: { userId: true, bucketStart: true },
      orderBy: [{ userId: 'asc' }, { bucketStart: 'asc' }],
    });
    attachActivitySampleCounts(matrix, samples, invalidations);
  }
  const users = await prisma.user.findMany({
    where: { id: { in: scope.userIds } },
    select: { id: true, name: true, email: true, avatarUrl: true, role: true },
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
  });
  return { matrix, users };
}

function attachActivitySampleCounts(
  matrix: TimesheetMatrix,
  samples: Array<{ userId: string; bucketStart: Date }>,
  invalidations: TimeInvalidationInput[] = [],
) {
  const invalidationsByUser = groupInvalidationsByUser(invalidations);
  const windows = matrix.days
    .map((day) => {
      const win = localDayWindow(day, matrix.tz);
      return win
        ? { day, startMs: win.start.getTime(), endMs: win.end.getTime() }
        : null;
    })
    .filter((win): win is { day: string; startMs: number; endMs: number } => win !== null);

  for (const sample of samples) {
    const userCells = matrix.cells[sample.userId];
    if (!userCells) continue;
    const t = sample.bucketStart.getTime();
    if (isInvalidatedAt(invalidationsByUser, sample.userId, t)) continue;
    for (const win of windows) {
      if (t < win.startMs || t >= win.endMs) continue;
      const cell = userCells[win.day];
      if (cell) cell.activitySampleCount += 1;
      break;
    }
  }
}

/**
 * GET /v1/admin/timesheets?from=YYYY-MM-DD&to=YYYY-MM-DD&tz=IANA
 *
 * Per-user × per-day matrix of total worked / meeting / manual time, scoped.
 * Powers the Team page — a Hubstaff-style at-a-glance view of "who tracked
 * what across the last week or two."
 *
 * Defaults: trailing 14 days ending today (in the requested tz, falling back
 * to UTC). Hard cap at 60 days so a typo can't melt the DB.
 */
adminRouter.get('/timesheets', requireAnyCapability(['reports.team.read', 'reports.workspace.read']), async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const range = resolveTimesheetRange(req);
    if ('error' in range) return res.status(range.status).json({ error: range.error, ...(range.extras ?? {}) });
    const { matrix, users } = await loadTimesheetData(req.scope, range);
    if (!matrix) return res.status(400).json({ error: 'invalid_date_or_tz' });
    res.json({ ...matrix, scope: req.scope.scope, users });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /v1/admin/timesheets.csv?from=&to=&tz=
 *
 * Same scope + range + validation as the JSON endpoint, but emits a row-per-
 * (user, day) CSV that opens cleanly in Excel/Sheets. Cells where the user
 * tracked nothing are dropped (zero rows, not blank rows) — managers
 * exporting a 30-day audit don't want to scroll through "Sat: 0".
 */
adminRouter.get('/timesheets.csv', requireAnyCapability(['reports.team.read', 'reports.workspace.read']), async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const range = resolveTimesheetRange(req);
    if ('error' in range) return res.status(range.status).json({ error: range.error, ...(range.extras ?? {}) });
    const { matrix, users } = await loadTimesheetData(req.scope, range);
    if (!matrix) return res.status(400).json({ error: 'invalid_date_or_tz' });

    const usersById = new Map(users.map((u) => [u.id, u]));
    const lines: string[] = [];
    lines.push(
      'name,email,role,day,worked_h,meeting_h,manual_h,total_h,invalidated_h,first_activity,last_activity,activity_samples',
    );
    // Stable ordering: user (role-then-name like the JSON), then day asc.
    for (const u of users) {
      const row = matrix.cells[u.id];
      if (!row) continue;
      for (const day of matrix.days) {
        const cell = row[day];
        if (!cell || cell.totalMs === 0) continue;
        const first = cell.firstActivityMs ? fmtTimeForTz(cell.firstActivityMs, matrix.tz) : '';
        const last = cell.lastActivityMs ? fmtTimeForTz(cell.lastActivityMs, matrix.tz) : '';
        lines.push(
          [
            csv(u.name),
            csv(u.email),
            u.role,
            day,
            msToHours(cell.workedMs),
            msToHours(cell.meetingMs),
            msToHours(cell.manualMs),
            msToHours(cell.totalMs),
            msToHours(cell.invalidatedMs),
            first,
            last,
            String(cell.activitySampleCount),
          ].join(','),
        );
      }
    }
    // Voider for usersById to suppress unused-warning since we use users
    // directly. Keeps the lookup if a future column needs it.
    void usersById;

    const filename = `timesheets-${range.from}-to-${range.to}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(lines.join('\n') + '\n');
  } catch (err) {
    next(err);
  }
});

/** Quote a CSV cell if it contains a comma, quote, or newline. */
function csv(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** 2-decimal hours, eg 90 min → "1.50". */
function msToHours(ms: number): string {
  return (ms / 3_600_000).toFixed(2);
}

/** Format an epoch in a tz as HH:MM (24h) for CSV. */
function fmtTimeForTz(ms: number, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

// ============================================================================
// Teams CRUD (read = MANAGER+, write = ADMIN)
// ============================================================================

interface TeamDto {
  id: string;
  name: string;
  managers: Array<{
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
    role: 'ADMIN' | 'MANAGER' | 'MEMBER';
    teamId: string | null;
  }>;
  managerIds: string[];
  managerCount: number;
  /** Compatibility alias for old clients; first manager by assignment time. */
  managerId: string | null;
  memberCount: number;
  createdAt: string;
}

function serializeTeam(t: {
  id: string;
  name: string;
  managers: Array<{
    user: {
      id: string;
      name: string;
      email: string;
      avatarUrl: string | null;
      role: 'ADMIN' | 'MANAGER' | 'MEMBER';
      teamId: string | null;
    };
  }>;
  members: Array<{ id: string }>;
  createdAt: Date;
}): TeamDto {
  const managers = t.managers.map((row) => row.user);
  return {
    id: t.id,
    name: t.name,
    managers,
    managerIds: managers.map((m) => m.id),
    managerCount: managers.length,
    managerId: managers[0]?.id ?? null,
    memberCount: t.members.length,
    createdAt: t.createdAt.toISOString(),
  };
}

function includeTeamForDto() {
  return {
    members: { select: { id: true } },
    managers: {
      orderBy: { createdAt: 'asc' as const },
      select: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            avatarUrl: true,
            role: true,
            teamId: true,
          },
        },
      },
    },
  };
}

async function loadTeamDto(teamId: string, workspaceId: string): Promise<TeamDto | null> {
  const team = await prisma.team.findFirst({
    where: { id: teamId, workspaceId },
    include: includeTeamForDto(),
  });
  return team ? serializeTeam(team) : null;
}

class TeamManagerRouteError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: {
      error: string;
      teamId?: string;
      teamName?: string;
      managedTeamId?: string;
      managedTeamName?: string;
    },
  ) {
    super(body.error);
  }
}

function throwTeamManagerError(result: Exclude<OrgMutationResult, { ok: true }>): never {
  const { ok: _ok, ...body } = result;
  if (result.error === 'manager_already_assigned') {
    throw new TeamManagerRouteError(409, body);
  }
  if (result.error === 'managed_user_team_locked') {
    throw new TeamManagerRouteError(409, body);
  }
  if (result.error === 'team_not_found') {
    throw new TeamManagerRouteError(404, { error: 'not_found' });
  }
  if (result.error === 'user_not_found') {
    throw new TeamManagerRouteError(404, { error: 'not_found' });
  }
  throw new TeamManagerRouteError(400, { error: result.error });
}

function isTeamManagerUniqueError(err: unknown) {
  const maybe = err as { code?: string; meta?: { target?: string[] } };
  return maybe?.code === 'P2002' && Array.isArray(maybe.meta?.target) && maybe.meta.target.includes('userId');
}

function hasCompletedMemberSetup(input: { teamId: string | null; shiftId: string | null }): boolean {
  return Boolean(input.teamId && input.shiftId);
}

/**
 * GET /v1/admin/teams — workspace teams visible to the caller.
 *
 * ADMIN         → every team in the workspace.
 * MANAGER       → their managed team.
 * MEMBER        → 403 (members don't need a team list; their teamId is on /me).
 */
adminRouter.get('/teams', requireCapability('teams.read'), async (req, res, next) => {
  try {
    if (!req.scope || !req.user) return res.status(401).json({ error: 'unauthorized' });
    const where: Prisma.TeamWhereInput = { workspaceId: req.scope.workspaceId };
    if (!req.scope.isAdmin) where.managers = { some: { userId: req.user.sub } };
    const teams = await prisma.team.findMany({
      where,
      include: includeTeamForDto(),
      orderBy: { name: 'asc' },
    });
    res.json({ teams: teams.map(serializeTeam) });
  } catch (err) {
    next(err);
  }
});

/** Body shape: { name: string, managerIds?: string[] } (managerId is accepted as a compatibility alias). */
adminRouter.post('/teams', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (name.length === 0 || name.length > 80) return res.status(400).json({ error: 'invalid_name' });
    const managerIds = normalizeManagerIds(req.body?.managerIds ?? req.body?.managerId);
    const teamId = await prisma.$transaction(async (tx) => {
      const team = await tx.team.create({
        data: { workspaceId: req.scope!.workspaceId, name },
        select: { id: true },
      });
      for (const managerId of managerIds) {
        const added = await addTeamManager(tx, { workspaceId: req.scope!.workspaceId, teamId: team.id, userId: managerId });
        if (!added.ok) throwTeamManagerError(added);
      }
      return team.id;
    });
    const team = await loadTeamDto(teamId, req.scope.workspaceId);
    res.status(201).json(team);
  } catch (err) {
    if (err instanceof TeamManagerRouteError) return res.status(err.status).json(err.body);
    if (isTeamManagerUniqueError(err)) return res.status(409).json({ error: 'manager_already_assigned' });
    next(err);
  }
});

/** PATCH body: { name?: string, managerIds?: string[] } (managerId replaces with one manager for old clients). */
adminRouter.patch('/teams/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const existing = await prisma.team.findUnique({ where: { id } });
    if (!existing || existing.workspaceId !== req.scope.workspaceId) {
      return res.status(404).json({ error: 'not_found' });
    }

    const data: { name?: string } = {};
    if (typeof req.body?.name === 'string') {
      const name = req.body.name.trim();
      if (name.length === 0 || name.length > 80) return res.status(400).json({ error: 'invalid_name' });
      data.name = name;
    }
    const replacesManagers = 'managerIds' in (req.body ?? {}) || 'managerId' in (req.body ?? {});
    const managerIds = replacesManagers
      ? normalizeManagerIds(req.body?.managerIds ?? req.body?.managerId)
      : null;
    if (Object.keys(data).length === 0 && !replacesManagers) return res.status(400).json({ error: 'nothing_to_update' });

    await prisma.$transaction(async (tx) => {
      if (Object.keys(data).length > 0) {
        await tx.team.update({ where: { id }, data });
      }
      if (managerIds) {
        const replaced = await replaceTeamManagers(tx, { workspaceId: req.scope!.workspaceId, teamId: id, managerIds });
        if (!replaced.ok) throwTeamManagerError(replaced);
      }
    });
    const team = await loadTeamDto(id, req.scope.workspaceId);
    res.json(team);
  } catch (err) {
    if (err instanceof TeamManagerRouteError) return res.status(err.status).json(err.body);
    if (isTeamManagerUniqueError(err)) return res.status(409).json({ error: 'manager_already_assigned' });
    next(err);
  }
});

adminRouter.post('/teams/:id/managers', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const teamId = req.params.id;
    if (!teamId) return res.status(400).json({ error: 'missing_id' });
    const userId = typeof req.body?.userId === 'string' ? req.body.userId.trim() : typeof req.body?.managerId === 'string' ? req.body.managerId.trim() : '';
    if (!userId) return res.status(400).json({ error: 'manager_required' });
    await prisma.$transaction(async (tx) => {
      const added = await addTeamManager(tx, { workspaceId: req.scope!.workspaceId, teamId, userId });
      if (!added.ok) throwTeamManagerError(added);
    });
    const team = await loadTeamDto(teamId, req.scope.workspaceId);
    if (!team) return res.status(404).json({ error: 'not_found' });
    res.status(201).json(team);
  } catch (err) {
    if (err instanceof TeamManagerRouteError) return res.status(err.status).json(err.body);
    if (isTeamManagerUniqueError(err)) return res.status(409).json({ error: 'manager_already_assigned' });
    next(err);
  }
});

adminRouter.delete('/teams/:id/managers/:userId', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const teamId = req.params.id;
    const userId = req.params.userId;
    if (!teamId || !userId) return res.status(400).json({ error: 'missing_id' });
    await prisma.$transaction(async (tx) => {
      const removed = await removeTeamManager(tx, { workspaceId: req.scope!.workspaceId, teamId, userId });
      if (!removed.ok) throwTeamManagerError(removed);
    });
    const team = await loadTeamDto(teamId, req.scope.workspaceId);
    if (!team) return res.status(404).json({ error: 'not_found' });
    res.json(team);
  } catch (err) {
    if (err instanceof TeamManagerRouteError) return res.status(err.status).json(err.body);
    next(err);
  }
});

/**
 * DELETE /v1/admin/teams/:id — drops the team. Members keep their User row;
 * their teamId silently goes null (Prisma onDelete: SetNull from the schema).
 * Lark identities and time history are untouched — managers may want to
 * re-team people on the dashboard's /users page after a reorg.
 */
adminRouter.delete('/teams/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const existing = await prisma.team.findUnique({ where: { id } });
    if (!existing || existing.workspaceId !== req.scope.workspaceId) {
      return res.status(404).json({ error: 'not_found' });
    }
    await prisma.$transaction(async (tx) => {
      const deleted = await deleteTeam(tx, { workspaceId: req.scope!.workspaceId, teamId: id });
      if (!deleted.ok) throwTeamManagerError(deleted);
    });
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof TeamManagerRouteError) return res.status(err.status).json(err.body);
    next(err);
  }
});

// ============================================================================
// PATCH a user (ADMIN-only). role / name / teamId / shiftId.
// ============================================================================

const VALID_ROLES = ['ADMIN', 'MANAGER', 'MEMBER'] as const;
type ValidRole = (typeof VALID_ROLES)[number];
const VALID_ACTIVITY_ROLE_TITLES = ['DEVELOPER', 'DESIGNER', 'SALES', 'OTHER'] as const;
type ValidActivityRoleTitle = (typeof VALID_ACTIVITY_ROLE_TITLES)[number];

adminRouter.patch('/users/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing || existing.workspaceId !== req.scope.workspaceId) {
      return res.status(404).json({ error: 'not_found' });
    }

    const data: {
      name?: string;
      role?: ValidRole;
      activityRoleTitle?: ValidActivityRoleTitle;
      managerId?: string | null;
      shiftId?: string | null;
      shiftAssignedAt?: Date | null;
      provisioningStatus?: 'ACTIVE';
    } = {};
    let requestedTeamId: string | null | undefined = undefined;
    let shiftAssignment:
      | {
          effectiveFrom: Date;
          shiftId: string | null;
          shiftNameSnapshot: string | null;
          scheduleSnapshot: Prisma.InputJsonValue | null;
          bufferMinSnapshot: number | null;
        }
      | null = null;

    if (typeof req.body?.name === 'string') {
      const name = req.body.name.trim();
      if (name.length === 0 || name.length > 80) return res.status(400).json({ error: 'invalid_name' });
      data.name = name;
    }

    if (typeof req.body?.role === 'string') {
      if (!(VALID_ROLES as readonly string[]).includes(req.body.role)) {
        return res.status(400).json({ error: 'invalid_role' });
      }
      if (req.body.role === 'MANAGER') {
        return res.status(400).json({ error: 'manager_role_is_derived' });
      }
      data.role = req.body.role as ValidRole;
    }

    if (typeof req.body?.activityRoleTitle === 'string') {
      if (!(VALID_ACTIVITY_ROLE_TITLES as readonly string[]).includes(req.body.activityRoleTitle)) {
        return res.status(400).json({ error: 'invalid_activity_role_title' });
      }
      data.activityRoleTitle = req.body.activityRoleTitle as ValidActivityRoleTitle;
    }

    if ('teamId' in (req.body ?? {})) {
      const raw = req.body.teamId;
      if (raw === null || raw === '') {
        requestedTeamId = null;
      } else if (typeof raw === 'string') {
        requestedTeamId = raw;
      } else {
        return res.status(400).json({ error: 'invalid_teamId' });
      }
    }

    if ('managerId' in (req.body ?? {})) {
      const raw = req.body.managerId;
      if (raw === null || raw === '') {
        data.managerId = null;
      } else {
        return res.status(400).json({ error: 'manager_id_deprecated' });
      }
    }

    // Forward-only shift assignment. New TimeEntries snapshot `shiftIdAtStart`;
    // history is preserved even when the user's shift later changes.
    if ('shiftId' in (req.body ?? {})) {
      const raw = req.body.shiftId;
      const effectiveFrom = new Date();
      if (raw === null || raw === '') {
        data.shiftId = null;
        data.shiftAssignedAt = null;
        shiftAssignment = {
          effectiveFrom,
          shiftId: null,
          shiftNameSnapshot: null,
          scheduleSnapshot: null,
          bufferMinSnapshot: null,
        };
      } else if (typeof raw === 'string') {
        const s = await prisma.shift.findUnique({
          where: { id: raw },
          select: { workspaceId: true, name: true, schedule: true, bufferMin: true },
        });
        if (!s || s.workspaceId !== req.scope.workspaceId) {
          return res.status(400).json({ error: 'shift_out_of_workspace' });
        }
        data.shiftId = raw;
        data.shiftAssignedAt = effectiveFrom;
        shiftAssignment = {
          effectiveFrom,
          shiftId: raw,
          shiftNameSnapshot: s.name,
          scheduleSnapshot: s.schedule,
          bufferMinSnapshot: s.bufferMin,
        };
      } else {
        return res.status(400).json({ error: 'invalid_shiftId' });
      }
    }

    if (
      existing.provisioningStatus === 'PENDING' &&
      !existing.deactivatedAt &&
      hasCompletedMemberSetup({
        teamId: requestedTeamId !== undefined ? requestedTeamId : existing.teamId,
        shiftId: data.shiftId !== undefined ? data.shiftId : existing.shiftId,
      })
    ) {
      data.provisioningStatus = 'ACTIVE';
    }

    if (Object.keys(data).length === 0 && requestedTeamId === undefined) return res.status(400).json({ error: 'nothing_to_update' });

    // Safety: never demote the workspace's last active ADMIN. Without this,
    // a careless admin could lock everyone out of full-workspace privileges.
    if (data.role && data.role !== 'ADMIN' && existing.role === 'ADMIN') {
      const admins = await prisma.user.count({
        where: { workspaceId: req.scope.workspaceId, role: 'ADMIN', deactivatedAt: null },
      });
      if (admins <= 1) return res.status(400).json({ error: 'last_admin_protected' });
    }
    if (data.role === 'MEMBER') {
      const managed = await prisma.teamManager.findUnique({
        where: { userId: id },
        select: { team: { select: { id: true, name: true } } },
      });
      if (managed) {
        return res.status(400).json({
          error: 'remove_team_manager_first',
          teamId: managed.team.id,
          teamName: managed.team.name,
        });
      }
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (shiftAssignment) {
        await tx.shiftAssignment.updateMany({
          where: { userId: id, effectiveTo: null },
          data: { effectiveTo: shiftAssignment.effectiveFrom },
        });
        await tx.shiftAssignment.create({
          data: {
            userId: id,
            shiftId: shiftAssignment.shiftId,
            effectiveFrom: shiftAssignment.effectiveFrom,
            shiftNameSnapshot: shiftAssignment.shiftNameSnapshot,
            bufferMinSnapshot: shiftAssignment.bufferMinSnapshot,
            ...(shiftAssignment.scheduleSnapshot === null ? {} : { scheduleSnapshot: shiftAssignment.scheduleSnapshot }),
          },
        });
      }
      if (Object.keys(data).length > 0) {
        await tx.user.update({
          where: { id },
          data,
        });
      }
      if (requestedTeamId !== undefined) {
        const assigned = await assignUserToTeam(tx, {
          workspaceId: req.scope!.workspaceId,
          userId: id,
          teamId: requestedTeamId,
          roleOverride: data.role,
        });
        if (!assigned.ok) throwTeamManagerError(assigned);
      }
      return tx.user.findUniqueOrThrow({
        where: { id },
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          activityRoleTitle: true,
          teamId: true,
          managerId: true,
          shiftId: true,
          provisioningStatus: true,
          deactivatedAt: true,
          createdAt: true,
        },
      });
    });
    res.json({
      ...updated,
      deactivatedAt: updated.deactivatedAt ? updated.deactivatedAt.toISOString() : null,
      createdAt: updated.createdAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof TeamManagerRouteError) return res.status(err.status).json(err.body);
    next(err);
  }
});

/**
 * POST /v1/admin/users
 *
 * Invite a new teammate. ADMIN-only. The new user is created in the
 * caller's workspace with a one-time random password — the user
 * resets it on first login via the existing /v1/auth flow (out of
 * scope here: emailing the credentials is the admin's responsibility
 * for v1; an email-based magic-link flow is a candidate for M19+).
 *
 * Returns 409 on a duplicate email (the email is workspace-global per
 * the schema's @unique constraint on User.email).
 */
adminRouter.post('/users', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });

    const emailRaw = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const nameRaw = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const roleRaw = typeof req.body?.role === 'string' ? req.body.role : 'MEMBER';
    const activityRoleRaw = typeof req.body?.activityRoleTitle === 'string' ? req.body.activityRoleTitle : 'OTHER';

    if (!emailRaw || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) {
      return res.status(400).json({ error: 'invalid_email' });
    }
    if (nameRaw.length === 0 || nameRaw.length > 80) {
      return res.status(400).json({ error: 'invalid_name' });
    }
    if (!(VALID_ROLES as readonly string[]).includes(roleRaw)) {
      return res.status(400).json({ error: 'invalid_role' });
    }
    if (roleRaw === 'MANAGER') {
      return res.status(400).json({ error: 'manager_role_is_derived' });
    }
    if (!(VALID_ACTIVITY_ROLE_TITLES as readonly string[]).includes(activityRoleRaw)) {
      return res.status(400).json({ error: 'invalid_activity_role_title' });
    }
    const dupe = await prisma.user.findUnique({ where: { email: emailRaw }, select: { id: true } });
    if (dupe) return res.status(409).json({ error: 'email_taken' });

    // Pre-create an ACTIVE shell with NO password — identity comes from Lark.
    // When this person first signs in with Lark, they're matched by email and
    // pick up this pre-assigned role (no PENDING review needed for invitees).
    // Capture settings are left NULL → inherit the workspace policy default.
    const created = await prisma.user.create({
      data: {
        workspaceId: req.scope.workspaceId,
        email: emailRaw,
        name: nameRaw,
        role: roleRaw as ValidRole,
        activityRoleTitle: activityRoleRaw as ValidActivityRoleTitle,
        passwordHash: null,
        provisioningStatus: 'ACTIVE',
      },
      select: { id: true, email: true, name: true, role: true, activityRoleTitle: true, provisioningStatus: true, createdAt: true },
    });
    res.status(201).json({ ...created, createdAt: created.createdAt.toISOString() });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /v1/admin/users/:id/deactivate
 *
 * Soft-deactivate. The user stays in the database (history + reports
 * preserved) but can't log in and won't appear in admin/scope queries.
 * Last-ADMIN safety mirrors the PATCH path — you can't lock the
 * workspace out of full privileges via deactivation either.
 */
adminRouter.post('/users/:id/deactivate', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing || existing.workspaceId !== req.scope.workspaceId) {
      return res.status(404).json({ error: 'not_found' });
    }
    if (existing.deactivatedAt) {
      return res.status(409).json({ error: 'already_deactivated' });
    }
    const managed = await prisma.teamManager.findUnique({
      where: { userId: id },
      select: { team: { select: { id: true, name: true } } },
    });
    if (managed) {
      return res.status(400).json({
        error: 'remove_team_manager_first',
        teamId: managed.team.id,
        teamName: managed.team.name,
      });
    }
    if (existing.role === 'ADMIN') {
      const admins = await prisma.user.count({
        where: { workspaceId: req.scope.workspaceId, role: 'ADMIN', deactivatedAt: null },
      });
      if (admins <= 1) return res.status(400).json({ error: 'last_admin_protected' });
    }
    const updated = await prisma.user.update({
      where: { id },
      data: { deactivatedAt: new Date() },
      select: { id: true, deactivatedAt: true },
    });
    res.json({ id: updated.id, deactivatedAt: updated.deactivatedAt!.toISOString() });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /v1/admin/users/:id/reactivate
 *
 * Reverse of deactivate. Idempotent: reactivating an already-active
 * user is a no-op + 200. Reactivation does NOT reset the password —
 * the user resumes with whatever creds they had before deactivation.
 */
adminRouter.post('/users/:id/reactivate', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing || existing.workspaceId !== req.scope.workspaceId) {
      return res.status(404).json({ error: 'not_found' });
    }
    if (!existing.deactivatedAt) {
      return res.json({ id: existing.id, deactivatedAt: null });
    }
    const updated = await prisma.user.update({
      where: { id },
      data: { deactivatedAt: null },
      select: { id: true, deactivatedAt: true },
    });
    res.json({ id: updated.id, deactivatedAt: updated.deactivatedAt });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /v1/admin/users/:id/activate
 *
 * Flip a PENDING (JIT-provisioned via Lark) user to ACTIVE so they can sign in.
 * The admin assigns team/manager/role via PATCH /users/:id first if desired;
 * this is the explicit "let them in" gate. Idempotent on an already-ACTIVE user.
 */
adminRouter.post('/users/:id/activate', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const existing = await prisma.user.findUnique({
      where: { id },
      select: { id: true, workspaceId: true, provisioningStatus: true, deactivatedAt: true },
    });
    if (!existing || existing.workspaceId !== req.scope.workspaceId) {
      return res.status(404).json({ error: 'not_found' });
    }
    if (existing.deactivatedAt) return res.status(409).json({ error: 'deactivated' });
    if (existing.provisioningStatus === 'ACTIVE') {
      return res.json({ id: existing.id, provisioningStatus: 'ACTIVE' });
    }
    const updated = await prisma.user.update({
      where: { id },
      data: { provisioningStatus: 'ACTIVE' },
      select: { id: true, provisioningStatus: true },
    });
    res.json({ id: updated.id, provisioningStatus: updated.provisioningStatus });
  } catch (err) {
    next(err);
  }
});

// ============================================================================
// Anti-cheat flags review queue (MANAGER+ read, MANAGER+ resolve in scope)
// ============================================================================

interface FlagDto {
  id: string;
  userId: string;
  user: { id: string; name: string; email: string; avatarUrl: string | null };
  type: string;
  windowStart: string;
  windowEnd: string;
  riskScore: number;
  evidence: unknown;
  /** AI-assist plain-language explanation of this flag (M17). */
  explanation: { headline: string; detail: string };
  status: 'OPEN' | 'RESOLVED';
  resolution: 'DISMISSED' | 'CONFIRMED' | 'TIME_INVALIDATED' | null;
  resolvedById: string | null;
  resolvedBy: { id: string; name: string } | null;
  resolvedAt: string | null;
  resolvedNote: string | null;
  createdAt: string;
}

/**
 * GET /v1/admin/flags
 *
 * Lists anti-cheat flags raised for users in the caller's scope.
 *   ?status=OPEN (default) | RESOLVED | ALL
 *   ?type=IMPOSSIBLE_RATE|METRONOMIC|...
 *
 * Highest-risk OPEN flags first, then most recent. MEMBERs are 403'd here —
 * exposing your own flag list would let a cheater calibrate their pattern
 * against the detector. Managers see their team; admins see the workspace.
 */
adminRouter.get('/flags', requireAnyCapability(['flags.team.review', 'flags.workspace.review']), async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const validStatuses = ['OPEN', 'RESOLVED'] as const;
    const validTypes = ['IMPOSSIBLE_RATE', 'METRONOMIC', 'LINEAR_MOUSE', 'SINGLE_CHANNEL', 'JIGGLER'] as const;
    const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : 'OPEN';
    const where: { userId: { in: string[] }; status?: (typeof validStatuses)[number]; type?: (typeof validTypes)[number] } = {
      userId: { in: req.scope.userIds },
    };
    if (status !== 'ALL') {
      if (!(validStatuses as readonly string[]).includes(status)) return res.status(400).json({ error: 'invalid_status' });
      where.status = status as (typeof validStatuses)[number];
    }
    if (typeof req.query.type === 'string') {
      const t = req.query.type.toUpperCase();
      if (!(validTypes as readonly string[]).includes(t)) return res.status(400).json({ error: 'invalid_type' });
      where.type = t as (typeof validTypes)[number];
    }
    const rows = await prisma.activityFlag.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, email: true, avatarUrl: true } },
        resolvedBy: { select: { id: true, name: true } },
      },
      orderBy: [
        // Most-risky open flags float to the top; resolved sorted by recency.
        { status: 'asc' },
        { riskScore: 'desc' },
        { createdAt: 'desc' },
      ],
      take: 200,
    });
    const flags: FlagDto[] = rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      user: { id: r.user.id, name: r.user.name, email: r.user.email, avatarUrl: r.user.avatarUrl },
      type: r.type,
      windowStart: r.windowStart.toISOString(),
      windowEnd: r.windowEnd.toISOString(),
      riskScore: r.riskScore,
      evidence: r.evidence,
      explanation: explainFlag({
        type: r.type,
        evidence: (r.evidence ?? {}) as Record<string, number>,
        riskScore: r.riskScore,
      }),
      status: r.status,
      resolution: r.resolution,
      resolvedById: r.resolvedById,
      resolvedBy: r.resolvedBy ? { id: r.resolvedBy.id, name: r.resolvedBy.name } : null,
      resolvedAt: r.resolvedAt ? r.resolvedAt.toISOString() : null,
      resolvedNote: r.resolvedNote,
      createdAt: r.createdAt.toISOString(),
    }));
    res.json({ flags, scope: req.scope.scope });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /v1/admin/flags/:id/resolve
 * Body: { resolution: 'DISMISSED' | 'CONFIRMED' | 'TIME_INVALIDATED', note?: string }
 *
 * Stamps the reviewer + verdict. The flag's subject user must be in the
 * caller's scope (managers can't dismiss flags from another team), and the
 * flag must currently be OPEN (re-resolving is a no-op 409 — the audit trail
 * is preserved by refusing the change).
 *
 * `TIME_INVALIDATED` is wired for a future hook that drops the matching
 * minutes from the user's TimeEntry. For now it lands as a verdict only —
 * no time is actually removed. Documenting this in the response keeps the
 * dashboard honest.
 */
const VALID_RESOLUTIONS = ['DISMISSED', 'CONFIRMED', 'TIME_INVALIDATED'] as const;
type FlagResolution = (typeof VALID_RESOLUTIONS)[number];

adminRouter.post('/flags/:id/resolve', requireAnyCapability(['flags.team.review', 'flags.workspace.review']), async (req, res, next) => {
  try {
    if (!req.scope || !req.user) return res.status(401).json({ error: 'unauthorized' });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const resolution = typeof req.body?.resolution === 'string' ? req.body.resolution : '';
    if (!(VALID_RESOLUTIONS as readonly string[]).includes(resolution)) {
      return res.status(400).json({ error: 'invalid_resolution' });
    }
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) || null : null;
    if (resolution === 'TIME_INVALIDATED' && !note) {
      return res.status(400).json({ error: 'missing_resolution_note' });
    }

    const existing = await prisma.activityFlag.findUnique({
      where: { id },
      include: { user: { select: { workspaceId: true } } },
    });
    if (!existing) return res.status(404).json({ error: 'not_found' });
    if (!req.scope.userIds.includes(existing.userId)) return res.status(403).json({ error: 'forbidden' });
    if (existing.status !== 'OPEN') return res.status(409).json({ error: 'already_resolved', resolution: existing.resolution });

    const invalidatedMs = resolution === 'TIME_INVALIDATED'
      ? await calculateInvalidatedMsForWindow(
          prisma,
          existing.userId,
          existing.windowStart,
          existing.windowEnd,
        )
      : 0;

    const updated = await prisma.$transaction(async (tx) => {
      const row = await tx.activityFlag.update({
        where: { id },
        data: {
          status: 'RESOLVED',
          resolution: resolution as FlagResolution,
          resolvedById: req.user!.sub,
          resolvedAt: new Date(),
          resolvedNote: note,
        },
      });
      if (resolution === 'TIME_INVALIDATED') {
        await tx.timeInvalidation.create({
          data: {
            workspaceId: existing.user.workspaceId,
            flagId: existing.id,
            userId: existing.userId,
            windowStart: existing.windowStart,
            windowEnd: existing.windowEnd,
            invalidatedById: req.user!.sub,
            reason: note!,
          },
        });
      }
      return row;
    });

    res.json({
      id: updated.id,
      status: updated.status,
      resolution: updated.resolution,
      resolvedAt: updated.resolvedAt ? updated.resolvedAt.toISOString() : null,
      resolvedNote: updated.resolvedNote,
      timeInvalidated: resolution === 'TIME_INVALIDATED',
      invalidatedMs,
    });
  } catch (err) {
    next(err);
  }
});

async function calculateInvalidatedMsForWindow(
  db: Pick<Prisma.TransactionClient, 'timeEntry'>,
  userId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<number> {
  const rows = await db.timeEntry.findMany({
    where: {
      userId,
      startedAt: { lt: windowEnd },
      OR: [{ endedAt: null }, { endedAt: { gt: windowStart } }],
    },
    select: {
      segments: { select: { kind: true, startedAt: true, endedAt: true } },
    },
  });
  const grouped = groupInvalidationsByUser([
    {
      userId,
      startedAt: windowStart.getTime(),
      endedAt: windowEnd.getTime(),
    },
  ]);
  let total = 0;
  for (const row of rows) {
    for (const s of row.segments) {
      if (s.kind === 'IDLE_TRIMMED') continue;
      const endedAt = s.endedAt ?? windowEnd;
      total += invalidatedOverlapMs(grouped, userId, s.startedAt.getTime(), endedAt.getTime());
    }
  }
  return total;
}

// ============================================================================
// Shifts CRUD (read = MANAGER+, write = ADMIN). Each user's `shiftId` is
// assigned via PATCH /v1/admin/users/:id (already extended above).
// ============================================================================

function serializeShift(s: {
  id: string;
  workspaceId: string;
  name: string;
  schedule: unknown;
  bufferMin: number;
  members: Array<{ id: string }>;
  createdAt: Date;
  updatedAt: Date;
}): ShiftDto {
  return {
    id: s.id,
    workspaceId: s.workspaceId,
    name: s.name,
    schedule: s.schedule as ShiftSchedule,
    bufferMin: s.bufferMin,
    memberCount: s.members.length,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

/**
 * GET /v1/admin/shifts — list shifts visible to the caller.
 *
 * MANAGER+ see workspace shifts (they need them to know who's on what).
 * MEMBER is 403 — they have /v1/me/shift for their own.
 */
adminRouter.get('/shifts', requireCapability('shifts.read'), async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const shifts = await prisma.shift.findMany({
      where: { workspaceId: req.scope.workspaceId },
      include: { members: { select: { id: true } } },
      orderBy: { name: 'asc' },
    });
    res.json({ shifts: shifts.map(serializeShift) });
  } catch (err) {
    next(err);
  }
});

adminRouter.post('/shifts', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const parsed = CreateShiftSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_body', detail: parsed.error.format() });
    }
    const shift = await prisma.shift.create({
      data: {
        workspaceId: req.scope.workspaceId,
        name: parsed.data.name,
        schedule: parsed.data.schedule,
        bufferMin: parsed.data.bufferMin,
      },
      include: { members: { select: { id: true } } },
    });
    res.status(201).json(serializeShift(shift));
  } catch (err) {
    next(err);
  }
});

adminRouter.patch('/shifts/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const existing = await prisma.shift.findUnique({ where: { id } });
    if (!existing || existing.workspaceId !== req.scope.workspaceId) {
      return res.status(404).json({ error: 'not_found' });
    }
    const parsed = PatchShiftSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid_body', detail: parsed.error.format() });
    }
    const data: { name?: string; schedule?: ShiftSchedule; bufferMin?: number } = {};
    if (parsed.data.name !== undefined) data.name = parsed.data.name;
    if (parsed.data.schedule !== undefined) data.schedule = parsed.data.schedule;
    if (parsed.data.bufferMin !== undefined) data.bufferMin = parsed.data.bufferMin;
    const updated = await prisma.shift.update({
      where: { id },
      data,
      include: { members: { select: { id: true } } },
    });
    res.json(serializeShift(updated));
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /v1/admin/shifts/:id — drop a shift. Members' `shiftId` goes
 * NULL via Prisma onDelete: SetNull. Past TimeEntries that snapshotted
 * `shiftIdAtStart = this.id` keep that string (no FK) so audit history is
 * preserved even though the row is gone.
 */
adminRouter.delete('/shifts/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const existing = await prisma.shift.findUnique({ where: { id } });
    if (!existing || existing.workspaceId !== req.scope.workspaceId) {
      return res.status(404).json({ error: 'not_found' });
    }
    await prisma.shift.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Suppress unused-import warning for ShiftScheduleSchema until a future
// route consumes it directly (currently consumed inside CreateShift/Patch).
void ShiftScheduleSchema;

// ============================================================================
// Reopen an auto-approved manual-time request (ADMIN-only override).
// ============================================================================

const REOPEN_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * POST /v1/admin/manual-time-requests/:id/reopen
 *
 * ADMIN override: take a request that was auto-approved by a manager-or-
 * above and flip it back to PENDING so the standard approver flow can
 * reject it. Only works if:
 *   - status === 'APPROVED' AND autoApproved === true (we don't reopen
 *     human-approved requests — those have a clear paper trail already)
 *   - decidedAt is within 24h (audit-safe window)
 *
 * Side effects:
 *   - DROPS the linked TimeEntry + its segments + its attendees (because
 *     the time is no longer trusted). The request itself stays as the
 *     audit record.
 *   - Clears decidedAt + decidedReason + timeEntryId. Sets autoApproved
 *     back to false.
 *   - status → PENDING so the regular /decide flow can act on it.
 *
 * Cross-workspace target → 404. Re-opening twice → 409 (status was
 * already PENDING).
 */
adminRouter.post('/manual-time-requests/:id/reopen', requireAdmin, async (req, res, next) => {
  try {
    if (!req.scope) return res.status(401).json({ error: 'unauthorized' });
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'missing_id' });
    const existing = await prisma.manualTimeRequest.findUnique({
      where: { id },
      include: { user: { select: { workspaceId: true } } },
    });
    if (!existing || existing.user.workspaceId !== req.scope.workspaceId) {
      return res.status(404).json({ error: 'not_found' });
    }
    if (existing.status !== 'APPROVED') {
      return res.status(409).json({ error: 'not_approved', status: existing.status });
    }
    if (!existing.autoApproved) {
      return res.status(409).json({ error: 'not_auto_approved' });
    }
    if (existing.decidedAt && Date.now() - existing.decidedAt.getTime() > REOPEN_WINDOW_MS) {
      return res.status(409).json({ error: 'reopen_window_expired' });
    }

    await prisma.$transaction(async (tx) => {
      // Drop the linked TimeEntry (segments + attendees cascade).
      if (existing.timeEntryId) {
        await tx.timeEntry.delete({ where: { id: existing.timeEntryId } }).catch(() => {
          /* already gone — race; nothing to do */
        });
      }
      await tx.manualTimeRequest.update({
        where: { id },
        data: {
          status: 'PENDING',
          version: { increment: 1 },
          autoApproved: false,
          decidedAt: null,
          decidedReason: null,
          decidedById: null,
          decisionSource: 'ADMIN_REOPEN',
          timeEntryId: null,
          approverId: null,
        },
      });
    });

    const reloaded = await prisma.manualTimeRequest.findUnique({
      where: { id },
      include: { attendees: true },
    });
    res.json({
      id: reloaded!.id,
      status: reloaded!.status,
      autoApproved: reloaded!.autoApproved,
    });
  } catch (err) {
    next(err);
  }
});

export default adminRouter;
