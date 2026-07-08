import { Router } from 'express';
import { prisma, type Prisma } from '@grind/db';
import { z } from 'zod';
import { requireApiToken } from '../middleware/apiToken';
import { buildTimesheetMatrix, dateRange, type TimesheetSegmentInput } from '../insights/timesheets';
import { localDayWindow } from '../insights/day';
import { loadTimeInvalidationsForUsers } from '../insights/timeInvalidations';

export const mcpRouter = Router();

const MAX_LIMIT = 200;
const MAX_SUMMARY_DAYS = 31;
const HEARTBEAT_FRESH_MS = 3 * 60 * 1000;

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TimezoneSchema = z.string().trim().min(1).max(80).default('UTC');
const LimitSchema = z.coerce.number().int().min(1).max(MAX_LIMIT).default(100);
const OptionalTextSchema = z.string().trim().min(1).max(120).optional();
const OptionalDateRangeSchema = z.object({
  from: DateSchema.optional(),
  to: DateSchema.optional(),
  tz: TimezoneSchema,
});

const deviceSelect = {
  agentLastSeenAt: true,
  agentState: true,
  agentVersion: true,
  agentPlatform: true,
  agentScreenPermissionStatus: true,
  agentScreenCaptureHealth: true,
  agentScreenPermissionState: true,
  agentAccessibilityTrusted: true,
  agentAccessibilityReady: true,
  agentAccessibilityRecording: true,
  agentAccessibilityCapturing: true,
  agentAccessibilityHookRunning: true,
  agentPermissionsUpdatedAt: true,
} satisfies Prisma.UserSelect;

type DeviceFields = {
  agentLastSeenAt: Date | null;
  agentState: string | null;
  agentVersion: string | null;
  agentPlatform: string | null;
  agentScreenPermissionStatus: string | null;
  agentScreenCaptureHealth: string | null;
  agentScreenPermissionState: string | null;
  agentAccessibilityTrusted: boolean | null;
  agentAccessibilityReady: boolean | null;
  agentAccessibilityRecording: boolean | null;
  agentAccessibilityCapturing: boolean | null;
  agentAccessibilityHookRunning: boolean | null;
  agentPermissionsUpdatedAt: Date | null;
};

type SummaryCell = {
  workedMs: number;
  meetingMs: number;
  manualMs: number;
  invalidatedMs: number;
  totalMs: number;
  firstActivityMs?: number | null;
  lastActivityMs?: number | null;
};

type TimeTotal = {
  workedMs: number;
  meetingMs: number;
  manualMs: number;
  invalidatedMs: number;
  totalMs: number;
};

type ValidRange = NonNullable<ReturnType<typeof validateRange>>;

function workspaceId(req: Express.Request): string {
  if (!req.apiToken) throw new Error('api_token_missing_after_auth');
  return req.apiToken.workspaceId;
}

function userSearch(q: string | undefined): Prisma.UserWhereInput {
  if (!q) return {};
  return {
    OR: [
      { name: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
    ],
  };
}

function todayForTz(tz: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(new Date())
      .slice(0, 10);
  } catch {
    return null;
  }
}

function validateRange(input: { from: string; to: string; tz: string }) {
  const fromWindow = localDayWindow(input.from, input.tz);
  const toWindow = localDayWindow(input.to, input.tz);
  if (!fromWindow || !toWindow) return null;
  const days = dateRange(input.from, input.to);
  if (days.length > MAX_SUMMARY_DAYS || days[0] !== input.from || days.at(-1) !== input.to) return null;
  return { from: input.from, to: input.to, tz: input.tz, fromWindow, toWindow, days };
}

function resolveOptionalRange(input: z.infer<typeof OptionalDateRangeSchema>) {
  if (input.from || input.to) {
    if (!input.from || !input.to) return { error: 'from_and_to_required' as const };
    const range = validateRange({ from: input.from, to: input.to, tz: input.tz });
    return range ?? { error: 'invalid_date_range' as const, maxDays: MAX_SUMMARY_DAYS };
  }

  const today = todayForTz(input.tz);
  if (!today) return { error: 'invalid_tz' as const };
  const range = validateRange({ from: today, to: today, tz: input.tz });
  return range ?? { error: 'invalid_date_range' as const, maxDays: MAX_SUMMARY_DAYS };
}

function emptyTotal(): TimeTotal {
  return { workedMs: 0, meetingMs: 0, manualMs: 0, invalidatedMs: 0, totalMs: 0 };
}

function addTotal(a: TimeTotal, b: TimeTotal): TimeTotal {
  return {
    workedMs: a.workedMs + b.workedMs,
    meetingMs: a.meetingMs + b.meetingMs,
    manualMs: a.manualMs + b.manualMs,
    invalidatedMs: a.invalidatedMs + b.invalidatedMs,
    totalMs: a.totalMs + b.totalMs,
  };
}

async function loadTimeMatrixForUsers(userIds: string[], range: ValidRange) {
  const entries = userIds.length === 0
    ? []
    : await prisma.timeEntry.findMany({
        where: {
          userId: { in: userIds },
          startedAt: { lt: range.toWindow.end },
          OR: [{ endedAt: null }, { endedAt: { gt: range.fromWindow.start } }],
        },
        select: {
          userId: true,
          source: true,
          endedAt: true,
          segments: {
            select: { kind: true, startedAt: true, endedAt: true },
            orderBy: { startedAt: 'asc' },
          },
        },
        orderBy: { startedAt: 'asc' },
      });

  const nowMs = Date.now();
  const segments: TimesheetSegmentInput[] = entries.flatMap((entry) =>
    entry.segments.map((segment) => ({
      userId: entry.userId,
      source: entry.source,
      segmentKind: segment.kind,
      startedAt: segment.startedAt.getTime(),
      endedAt: (segment.endedAt ?? entry.endedAt ?? new Date(nowMs)).getTime(),
    })),
  );
  const invalidations = await loadTimeInvalidationsForUsers(userIds, range.fromWindow.start, range.toWindow.end);
  return buildTimesheetMatrix({
    from: range.from,
    to: range.to,
    tz: range.tz,
    segments,
    invalidations,
  });
}

function cellsForUser(matrix: NonNullable<Awaited<ReturnType<typeof loadTimeMatrixForUsers>>>, userId: string) {
  return (matrix.cells[userId] ?? {}) as Record<string, SummaryCell | undefined>;
}

function totalForCells(cells: Record<string, SummaryCell | undefined>): TimeTotal {
  return Object.values(cells).reduce(
    (acc, cell) => (cell ? addTotal(acc, cell) : acc),
    emptyTotal(),
  );
}

function dayRows(range: ValidRange, cells: Record<string, SummaryCell | undefined>) {
  return range.days.map((day) => ({
    date: day,
    workedMs: cells[day]?.workedMs ?? 0,
    meetingMs: cells[day]?.meetingMs ?? 0,
    manualMs: cells[day]?.manualMs ?? 0,
    invalidatedMs: cells[day]?.invalidatedMs ?? 0,
    totalMs: cells[day]?.totalMs ?? 0,
    firstActivityAt: cells[day]?.firstActivityMs
      ? new Date(cells[day]!.firstActivityMs!).toISOString()
      : null,
    lastActivityAt: cells[day]?.lastActivityMs
      ? new Date(cells[day]!.lastActivityMs!).toISOString()
      : null,
  }));
}

function isBadStatus(value: string | null): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase().replace(/\s+/g, '_');
  return [
    'denied',
    'missing',
    'failed',
    'error',
    'not_granted',
    'restricted',
    'unavailable',
    'disabled',
  ].some((marker) => normalized.includes(marker));
}

function serializeDevice(user: DeviceFields, now = new Date()) {
  const lastSeenMs = user.agentLastSeenAt?.getTime() ?? null;
  const heartbeatAgeMs = lastSeenMs === null ? null : Math.max(0, now.getTime() - lastSeenMs);
  const heartbeatFresh = heartbeatAgeMs !== null && heartbeatAgeMs <= HEARTBEAT_FRESH_MS;
  const running = user.agentState === 'RUNNING' && heartbeatFresh;
  const stale = user.agentLastSeenAt !== null && !heartbeatFresh;
  const screenIssue =
    isBadStatus(user.agentScreenPermissionStatus) ||
    isBadStatus(user.agentScreenCaptureHealth) ||
    isBadStatus(user.agentScreenPermissionState);
  const accessibilityIssue = [
    user.agentAccessibilityTrusted,
    user.agentAccessibilityReady,
    user.agentAccessibilityRecording,
    user.agentAccessibilityCapturing,
    user.agentAccessibilityHookRunning,
  ].some((value) => value === false);

  return {
    platform: user.agentPlatform,
    version: user.agentVersion,
    state: user.agentState,
    status: running
      ? 'running'
      : user.agentLastSeenAt === null
        ? 'no_heartbeat'
        : stale
          ? 'stale'
          : (user.agentState ?? 'unknown').toLowerCase(),
    running,
    heartbeatFresh,
    heartbeatAgeMs,
    freshWithinMs: HEARTBEAT_FRESH_MS,
    lastSeenAt: user.agentLastSeenAt?.toISOString() ?? null,
    permissionsUpdatedAt: user.agentPermissionsUpdatedAt?.toISOString() ?? null,
    permissionIssues: {
      screen: screenIssue,
      accessibility: accessibilityIssue,
      any: screenIssue || accessibilityIssue,
    },
    screen: {
      permissionStatus: user.agentScreenPermissionStatus,
      captureHealth: user.agentScreenCaptureHealth,
      permissionState: user.agentScreenPermissionState,
    },
    accessibility: {
      trusted: user.agentAccessibilityTrusted,
      ready: user.agentAccessibilityReady,
      recording: user.agentAccessibilityRecording,
      capturing: user.agentAccessibilityCapturing,
      hookRunning: user.agentAccessibilityHookRunning,
    },
  };
}

function versionBuckets(users: Array<DeviceFields>) {
  const buckets = new Map<string, { platform: string; version: string; state: string; count: number }>();
  for (const user of users) {
    const platform = user.agentPlatform ?? 'unknown';
    const version = user.agentVersion ?? 'unknown';
    const state = user.agentState ?? 'unknown';
    const key = `${platform}\u0000${version}\u0000${state}`;
    const bucket = buckets.get(key) ?? { platform, version, state, count: 0 };
    bucket.count += 1;
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) =>
    `${a.platform} ${a.version} ${a.state}`.localeCompare(`${b.platform} ${b.version} ${b.state}`),
  );
}

mcpRouter.get('/workspace-overview', requireApiToken([
  'read:people',
  'read:device-health',
  'read:time-summary',
  'read:manual-time',
]), async (req, res, next) => {
  try {
    const query = z.object({ tz: TimezoneSchema }).safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'invalid_query', issues: query.error.issues });

    const ws = workspaceId(req);
    const range = resolveOptionalRange({ tz: query.data.tz });
    if ('error' in range) return res.status(400).json(range);

    const now = new Date();
    const [users, teamCount, pendingManualTime, openFlagCount] = await Promise.all([
      prisma.user.findMany({
        where: { workspaceId: ws, deactivatedAt: null },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          team: { select: { id: true, name: true } },
          ...deviceSelect,
        },
        orderBy: { name: 'asc' },
      }),
      prisma.team.count({ where: { workspaceId: ws } }),
      prisma.manualTimeRequest.count({
        where: { status: 'PENDING', user: { workspaceId: ws, deactivatedAt: null } },
      }),
      prisma.activityFlag.count({
        where: { status: 'OPEN', user: { workspaceId: ws, deactivatedAt: null } },
      }),
    ]);

    const matrix = await loadTimeMatrixForUsers(users.map((user) => user.id), range);
    if (!matrix) return res.status(400).json({ error: 'invalid_date_range', maxDays: MAX_SUMMARY_DAYS });

    let todayTotal = emptyTotal();
    let activeUsers = 0;
    const deviceRows = users.map((user) => serializeDevice(user, now));
    for (const user of users) {
      const total = totalForCells(cellsForUser(matrix, user.id));
      if (total.totalMs > 0) activeUsers += 1;
      todayTotal = addTotal(todayTotal, total);
    }

    res.json({
      generatedAt: now.toISOString(),
      scope: 'workspace',
      limits: { maxSummaryDays: MAX_SUMMARY_DAYS, maxRows: MAX_LIMIT },
      people: {
        total: users.length,
        activeToday: activeUsers,
        roles: {
          admins: users.filter((user) => user.role === 'ADMIN').length,
          managers: users.filter((user) => user.role === 'MANAGER').length,
          members: users.filter((user) => user.role === 'MEMBER').length,
        },
      },
      teams: { total: teamCount },
      devices: {
        running: deviceRows.filter((device) => device.running).length,
        stale: deviceRows.filter((device) => device.status === 'stale').length,
        noHeartbeat: deviceRows.filter((device) => device.status === 'no_heartbeat').length,
        permissionIssues: deviceRows.filter((device) => device.permissionIssues.any).length,
      },
      versions: {
        buckets: versionBuckets(users),
        unknownUsers: users.filter((user) => !user.agentVersion).length,
      },
      today: {
        date: range.from,
        tz: range.tz,
        total: todayTotal,
      },
      manualTime: {
        pendingTotal: pendingManualTime,
      },
      activityFlags: {
        openTotal: openFlagCount,
      },
      sampleUsers: users.slice(0, 25).map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        team: user.team,
        device: serializeDevice(user, now),
      })),
      truncatedSampleUsers: users.length > 25,
    });
  } catch (err) {
    next(err);
  }
});

mcpRouter.get('/people', requireApiToken(['read:people', 'read:device-health']), async (req, res, next) => {
  try {
    const query = z.object({
      q: OptionalTextSchema,
      role: z.enum(['ADMIN', 'MANAGER', 'MEMBER']).optional(),
      limit: LimitSchema,
    }).safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'invalid_query', issues: query.error.issues });

    const users = await prisma.user.findMany({
      where: {
        workspaceId: workspaceId(req),
        deactivatedAt: null,
        ...(query.data.role ? { role: query.data.role } : {}),
        ...userSearch(query.data.q),
      },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        activityRoleTitle: true,
        team: { select: { id: true, name: true } },
        managedTeamAssignment: { select: { team: { select: { id: true, name: true } } } },
        shift: { select: { id: true, name: true } },
        createdAt: true,
        ...deviceSelect,
      },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
      take: query.data.limit,
    });

    const now = new Date();
    res.json({
      generatedAt: now.toISOString(),
      users: users.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        activityRoleTitle: user.activityRoleTitle,
        team: user.team,
        managesTeam: user.managedTeamAssignment?.team ?? null,
        shift: user.shift,
        createdAt: user.createdAt.toISOString(),
        device: serializeDevice(user, now),
      })),
    });
  } catch (err) {
    next(err);
  }
});

mcpRouter.get('/user-detail', requireApiToken([
  'read:people',
  'read:device-health',
  'read:time-summary',
  'read:manual-time',
]), async (req, res, next) => {
  try {
    const query = z.object({
      userId: z.string().trim().min(1).max(120).optional(),
      email: z.string().trim().min(3).max(254).optional(),
      q: OptionalTextSchema,
      ...OptionalDateRangeSchema.shape,
    }).safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'invalid_query', issues: query.error.issues });
    if (!query.data.userId && !query.data.email && !query.data.q) {
      return res.status(400).json({ error: 'user_lookup_required' });
    }

    const range = resolveOptionalRange(query.data);
    if ('error' in range) return res.status(400).json(range);

    const where: Prisma.UserWhereInput = {
      workspaceId: workspaceId(req),
      deactivatedAt: null,
      ...(query.data.userId ? { id: query.data.userId } : {}),
      ...(query.data.email ? { email: { equals: query.data.email, mode: 'insensitive' } } : {}),
      ...userSearch(query.data.q),
    };
    const matches = await prisma.user.findMany({
      where,
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        activityRoleTitle: true,
        team: { select: { id: true, name: true } },
        managedTeamAssignment: { select: { team: { select: { id: true, name: true } } } },
        shift: { select: { id: true, name: true } },
        createdAt: true,
        ...deviceSelect,
      },
      orderBy: { name: 'asc' },
      take: 5,
    });
    const user = matches[0];
    if (!user) return res.status(404).json({ error: 'not_found' });

    const matrix = await loadTimeMatrixForUsers([user.id], range);
    if (!matrix) return res.status(400).json({ error: 'invalid_date_range', maxDays: MAX_SUMMARY_DAYS });
    const manualRequests = await prisma.manualTimeRequest.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        taskSummary: true,
        requestedStart: true,
        requestedEnd: true,
        reason: true,
        status: true,
        approver: { select: { id: true, name: true, email: true } },
        decidedBy: { select: { id: true, name: true, email: true } },
        decidedAt: true,
        decidedReason: true,
        autoApproved: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const cells = cellsForUser(matrix, user.id);

    res.json({
      generatedAt: new Date().toISOString(),
      matchCount: matches.length,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        activityRoleTitle: user.activityRoleTitle,
        team: user.team,
        managesTeam: user.managedTeamAssignment?.team ?? null,
        shift: user.shift,
        createdAt: user.createdAt.toISOString(),
        device: serializeDevice(user),
      },
      time: {
        from: range.from,
        to: range.to,
        tz: range.tz,
        total: totalForCells(cells),
        days: dayRows(range, cells),
      },
      manualTimeRequests: manualRequests.map((request) => ({
        id: request.id,
        taskSummary: request.taskSummary,
        requestedStart: request.requestedStart.toISOString(),
        requestedEnd: request.requestedEnd.toISOString(),
        durationMs: request.requestedEnd.getTime() - request.requestedStart.getTime(),
        reason: request.reason,
        status: request.status,
        approver: request.approver,
        decidedBy: request.decidedBy,
        decidedAt: request.decidedAt?.toISOString() ?? null,
        decidedReason: request.decidedReason,
        autoApproved: request.autoApproved,
        createdAt: request.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    next(err);
  }
});

mcpRouter.get('/device-health', requireApiToken(['read:device-health']), async (req, res, next) => {
  try {
    const query = z.object({
      q: OptionalTextSchema,
      platform: z.string().trim().min(1).max(32).optional(),
      version: z.string().trim().min(1).max(80).optional(),
      limit: LimitSchema,
    }).safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'invalid_query', issues: query.error.issues });

    const users = await prisma.user.findMany({
      where: {
        workspaceId: workspaceId(req),
        deactivatedAt: null,
        ...(query.data.platform ? { agentPlatform: query.data.platform } : {}),
        ...(query.data.version ? { agentVersion: query.data.version } : {}),
        ...userSearch(query.data.q),
      },
      select: {
        id: true,
        name: true,
        email: true,
        ...deviceSelect,
      },
      orderBy: [{ agentLastSeenAt: 'desc' }, { name: 'asc' }],
      take: query.data.limit,
    });

    const now = new Date();
    const devices = users.map((user) => serializeDevice(user, now));
    res.json({
      generatedAt: now.toISOString(),
      counts: {
        total: users.length,
        running: devices.filter((device) => device.running).length,
        stale: devices.filter((device) => device.status === 'stale').length,
        noHeartbeat: devices.filter((device) => device.status === 'no_heartbeat').length,
        permissionIssues: devices.filter((device) => device.permissionIssues.any).length,
      },
      users: users.map((user) => {
        const device = serializeDevice(user, now);
        return {
          id: user.id,
          name: user.name,
          email: user.email,
          platform: user.agentPlatform,
          version: user.agentVersion,
          state: user.agentState,
          lastSeenAt: user.agentLastSeenAt?.toISOString() ?? null,
          permissionsUpdatedAt: user.agentPermissionsUpdatedAt?.toISOString() ?? null,
          screen: device.screen,
          accessibility: device.accessibility,
          device,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

mcpRouter.get('/version-adoption', requireApiToken(['read:device-health']), async (req, res, next) => {
  try {
    const query = z.object({
      version: z.string().trim().min(1).max(80).optional(),
    }).safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'invalid_query', issues: query.error.issues });

    const users = await prisma.user.findMany({
      where: {
        workspaceId: workspaceId(req),
        deactivatedAt: null,
        ...(query.data.version ? { agentVersion: query.data.version } : {}),
      },
      select: {
        id: true,
        name: true,
        email: true,
        ...deviceSelect,
      },
      orderBy: [{ agentVersion: 'asc' }, { name: 'asc' }],
    });
    const now = new Date();

    res.json({
      generatedAt: now.toISOString(),
      totalUsers: users.length,
      buckets: versionBuckets(users),
      unknownUsers: users.filter((user) => !user.agentVersion).length,
      runningUsers: users.filter((user) => serializeDevice(user, now).running).length,
      staleUsers: users.filter((user) => serializeDevice(user, now).status === 'stale').length,
      users: users.slice(0, MAX_LIMIT).map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        platform: user.agentPlatform,
        version: user.agentVersion,
        state: user.agentState,
        lastSeenAt: user.agentLastSeenAt?.toISOString() ?? null,
        deviceStatus: serializeDevice(user, now).status,
      })),
      truncatedUsers: users.length > MAX_LIMIT,
    });
  } catch (err) {
    next(err);
  }
});

mcpRouter.get('/running-users', requireApiToken(['read:people', 'read:device-health']), async (req, res, next) => {
  try {
    const now = new Date();
    const users = await prisma.user.findMany({
      where: {
        workspaceId: workspaceId(req),
        deactivatedAt: null,
        agentState: 'RUNNING',
        agentLastSeenAt: { gte: new Date(now.getTime() - HEARTBEAT_FRESH_MS) },
      },
      select: {
        id: true,
        name: true,
        email: true,
        agentActiveEntryId: true,
        ...deviceSelect,
      },
      orderBy: [{ agentLastSeenAt: 'desc' }, { name: 'asc' }],
      take: MAX_LIMIT,
    });
    res.json({
      generatedAt: now.toISOString(),
      freshWithinMs: HEARTBEAT_FRESH_MS,
      users: users.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        activeEntryId: user.agentActiveEntryId,
        lastSeenAt: user.agentLastSeenAt?.toISOString() ?? null,
        version: user.agentVersion,
        platform: user.agentPlatform,
        device: serializeDevice(user, now),
      })),
    });
  } catch (err) {
    next(err);
  }
});

mcpRouter.get('/team-summary', requireApiToken(['read:people', 'read:device-health', 'read:time-summary']), async (req, res, next) => {
  try {
    const query = z.object({
      teamId: z.string().trim().min(1).max(120).optional(),
      q: OptionalTextSchema,
      limit: LimitSchema,
      ...OptionalDateRangeSchema.shape,
    }).safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'invalid_query', issues: query.error.issues });

    const range = resolveOptionalRange(query.data);
    if ('error' in range) return res.status(400).json(range);

    const teams = await prisma.team.findMany({
      where: {
        workspaceId: workspaceId(req),
        ...(query.data.teamId ? { id: query.data.teamId } : {}),
        ...(query.data.q ? { name: { contains: query.data.q, mode: 'insensitive' } } : {}),
      },
      select: {
        id: true,
        name: true,
        createdAt: true,
        updatedAt: true,
        managers: {
          select: {
            user: {
              select: { id: true, name: true, email: true, role: true, ...deviceSelect },
            },
          },
        },
        members: {
          where: { deactivatedAt: null },
          select: { id: true, name: true, email: true, role: true, ...deviceSelect },
          orderBy: { name: 'asc' },
        },
      },
      orderBy: { name: 'asc' },
      take: query.data.limit,
    });

    const userIds = [...new Set(teams.flatMap((team) => [
      ...team.members.map((user) => user.id),
      ...team.managers.map((manager) => manager.user.id),
    ]))];
    const matrix = await loadTimeMatrixForUsers(userIds, range);
    if (!matrix) return res.status(400).json({ error: 'invalid_date_range', maxDays: MAX_SUMMARY_DAYS });

    const now = new Date();
    res.json({
      generatedAt: now.toISOString(),
      from: range.from,
      to: range.to,
      tz: range.tz,
      teams: teams.map((team) => {
        const roster = new Map<string, typeof team.members[number]>();
        for (const user of team.members) roster.set(user.id, user);
        for (const manager of team.managers) roster.set(manager.user.id, manager.user);
        let total = emptyTotal();
        const devices = [...roster.values()].map((user) => serializeDevice(user, now));
        for (const user of roster.values()) total = addTotal(total, totalForCells(cellsForUser(matrix, user.id)));
        return {
          id: team.id,
          name: team.name,
          createdAt: team.createdAt.toISOString(),
          updatedAt: team.updatedAt.toISOString(),
          managers: team.managers.map((manager) => ({
            id: manager.user.id,
            name: manager.user.name,
            email: manager.user.email,
            role: manager.user.role,
          })),
          memberCount: roster.size,
          deviceCounts: {
            running: devices.filter((device) => device.running).length,
            stale: devices.filter((device) => device.status === 'stale').length,
            noHeartbeat: devices.filter((device) => device.status === 'no_heartbeat').length,
            permissionIssues: devices.filter((device) => device.permissionIssues.any).length,
          },
          time: { total },
          roster: [...roster.values()].slice(0, 50).map((user) => ({
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            device: serializeDevice(user, now),
            time: {
              total: totalForCells(cellsForUser(matrix, user.id)),
            },
          })),
          truncatedRoster: roster.size > 50,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

mcpRouter.get('/time-summary', requireApiToken(['read:time-summary']), async (req, res, next) => {
  try {
    const query = z.object({
      from: DateSchema,
      to: DateSchema,
      tz: TimezoneSchema,
      userId: z.string().trim().min(1).max(120).optional(),
    }).safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'invalid_query', issues: query.error.issues });

    const range = validateRange(query.data);
    if (!range) return res.status(400).json({ error: 'invalid_date_range', maxDays: MAX_SUMMARY_DAYS });

    const users = await prisma.user.findMany({
      where: {
        workspaceId: workspaceId(req),
        deactivatedAt: null,
        ...(query.data.userId ? { id: query.data.userId } : {}),
      },
      select: { id: true, name: true, email: true, role: true },
      orderBy: { name: 'asc' },
      take: MAX_LIMIT,
    });
    const matrix = await loadTimeMatrixForUsers(users.map((user) => user.id), range);
    if (!matrix) return res.status(400).json({ error: 'invalid_date_range', maxDays: MAX_SUMMARY_DAYS });

    res.json({
      generatedAt: new Date().toISOString(),
      from: matrix.from,
      to: matrix.to,
      tz: matrix.tz,
      limits: { maxSummaryDays: MAX_SUMMARY_DAYS, maxRows: MAX_LIMIT },
      users: users.map((user) => {
        const cells = cellsForUser(matrix, user.id);
        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          total: totalForCells(cells),
          days: dayRows(range, cells),
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

mcpRouter.get('/manual-time-requests', requireApiToken(['read:manual-time']), async (req, res, next) => {
  try {
    const query = z.object({
      status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional(),
      from: DateSchema.optional(),
      to: DateSchema.optional(),
      tz: TimezoneSchema,
      limit: LimitSchema,
    }).safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'invalid_query', issues: query.error.issues });

    let requestedRange: { requestedStart: { lt: Date }; requestedEnd: { gt: Date } } | undefined;
    if (query.data.from || query.data.to) {
      if (!query.data.from || !query.data.to) return res.status(400).json({ error: 'from_and_to_required' });
      const range = validateRange({ from: query.data.from, to: query.data.to, tz: query.data.tz });
      if (!range) return res.status(400).json({ error: 'invalid_date_range', maxDays: MAX_SUMMARY_DAYS });
      requestedRange = {
        requestedStart: { lt: range.toWindow.end },
        requestedEnd: { gt: range.fromWindow.start },
      };
    }

    const requests = await prisma.manualTimeRequest.findMany({
      where: {
        user: { workspaceId: workspaceId(req), deactivatedAt: null },
        ...(query.data.status ? { status: query.data.status } : {}),
        ...requestedRange,
      },
      select: {
        id: true,
        user: { select: { id: true, name: true, email: true } },
        larkTaskGuid: true,
        taskSummary: true,
        requestedStart: true,
        requestedEnd: true,
        reason: true,
        status: true,
        approver: { select: { id: true, name: true, email: true } },
        decidedBy: { select: { id: true, name: true, email: true } },
        decidedAt: true,
        decidedReason: true,
        autoApproved: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ createdAt: 'desc' }],
      take: query.data.limit,
    });
    const statusCounts = requests.reduce<Record<string, number>>((acc, request) => {
      acc[request.status] = (acc[request.status] ?? 0) + 1;
      return acc;
    }, {});

    res.json({
      generatedAt: new Date().toISOString(),
      counts: statusCounts,
      requests: requests.map((request) => ({
        id: request.id,
        user: request.user,
        taskGuid: request.larkTaskGuid,
        taskSummary: request.taskSummary,
        requestedStart: request.requestedStart.toISOString(),
        requestedEnd: request.requestedEnd.toISOString(),
        durationMs: request.requestedEnd.getTime() - request.requestedStart.getTime(),
        reason: request.reason,
        status: request.status,
        approver: request.approver,
        decidedBy: request.decidedBy,
        decidedAt: request.decidedAt?.toISOString() ?? null,
        decidedReason: request.decidedReason,
        autoApproved: request.autoApproved,
        createdAt: request.createdAt.toISOString(),
        updatedAt: request.updatedAt.toISOString(),
      })),
    });
  } catch (err) {
    next(err);
  }
});

mcpRouter.get('/activity-flags-summary', requireApiToken(['read:people', 'read:time-summary']), async (req, res, next) => {
  try {
    const query = z.object({
      status: z.enum(['OPEN', 'RESOLVED']).optional(),
      from: DateSchema.optional(),
      to: DateSchema.optional(),
      tz: TimezoneSchema,
      limit: LimitSchema,
    }).safeParse(req.query);
    if (!query.success) return res.status(400).json({ error: 'invalid_query', issues: query.error.issues });

    let windowRange: { windowStart: { lt: Date; gte?: Date } } | undefined;
    if (query.data.from || query.data.to) {
      if (!query.data.from || !query.data.to) return res.status(400).json({ error: 'from_and_to_required' });
      const range = validateRange({ from: query.data.from, to: query.data.to, tz: query.data.tz });
      if (!range) return res.status(400).json({ error: 'invalid_date_range', maxDays: MAX_SUMMARY_DAYS });
      windowRange = { windowStart: { gte: range.fromWindow.start, lt: range.toWindow.end } };
    }

    const where: Prisma.ActivityFlagWhereInput = {
      user: { workspaceId: workspaceId(req), deactivatedAt: null },
      ...(query.data.status ? { status: query.data.status } : {}),
      ...windowRange,
    };
    const [byStatus, byType, recent] = await Promise.all([
      prisma.activityFlag.groupBy({ by: ['status'], where, _count: { _all: true } }),
      prisma.activityFlag.groupBy({ by: ['type'], where, _count: { _all: true } }),
      prisma.activityFlag.findMany({
        where,
        select: {
          id: true,
          type: true,
          status: true,
          resolution: true,
          riskScore: true,
          windowStart: true,
          windowEnd: true,
          createdAt: true,
          resolvedAt: true,
          user: { select: { id: true, name: true, email: true } },
          resolvedBy: { select: { id: true, name: true, email: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: query.data.limit,
      }),
    ]);

    res.json({
      generatedAt: new Date().toISOString(),
      counts: {
        byStatus: byStatus.map((row) => ({ status: row.status, count: row._count._all })),
        byType: byType.map((row) => ({ type: row.type, count: row._count._all })),
      },
      flags: recent.map((flag) => ({
        id: flag.id,
        user: flag.user,
        type: flag.type,
        status: flag.status,
        resolution: flag.resolution,
        riskScore: flag.riskScore,
        windowStart: flag.windowStart.toISOString(),
        windowEnd: flag.windowEnd.toISOString(),
        createdAt: flag.createdAt.toISOString(),
        resolvedAt: flag.resolvedAt?.toISOString() ?? null,
        resolvedBy: flag.resolvedBy,
      })),
    });
  } catch (err) {
    next(err);
  }
});
