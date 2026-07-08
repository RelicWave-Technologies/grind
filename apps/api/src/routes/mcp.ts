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

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const LimitSchema = z.coerce.number().int().min(1).max(MAX_LIMIT).default(100);
const OptionalTextSchema = z.string().trim().min(1).max(120).optional();

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

function validateRange(input: { from: string; to: string; tz: string }) {
  const fromWindow = localDayWindow(input.from, input.tz);
  const toWindow = localDayWindow(input.to, input.tz);
  if (!fromWindow || !toWindow) return null;
  const days = dateRange(input.from, input.to);
  if (days.length > MAX_SUMMARY_DAYS || days[0] !== input.from || days.at(-1) !== input.to) return null;
  return { fromWindow, toWindow, days };
}

mcpRouter.get('/people', requireApiToken(['read:people']), async (req, res, next) => {
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
      },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
      take: query.data.limit,
    });

    res.json({
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
      },
      orderBy: [{ agentLastSeenAt: 'desc' }, { name: 'asc' }],
      take: query.data.limit,
    });

    res.json({
      users: users.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        platform: user.agentPlatform,
        version: user.agentVersion,
        state: user.agentState,
        lastSeenAt: user.agentLastSeenAt?.toISOString() ?? null,
        permissionsUpdatedAt: user.agentPermissionsUpdatedAt?.toISOString() ?? null,
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
      })),
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
        agentVersion: true,
        agentPlatform: true,
        agentState: true,
        agentLastSeenAt: true,
      },
      orderBy: [{ agentVersion: 'asc' }, { name: 'asc' }],
    });

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

    res.json({
      totalUsers: users.length,
      buckets: [...buckets.values()].sort((a, b) =>
        `${a.platform} ${a.version} ${a.state}`.localeCompare(`${b.platform} ${b.version} ${b.state}`),
      ),
      users: users.slice(0, MAX_LIMIT).map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        platform: user.agentPlatform,
        version: user.agentVersion,
        state: user.agentState,
        lastSeenAt: user.agentLastSeenAt?.toISOString() ?? null,
      })),
      truncatedUsers: users.length > MAX_LIMIT,
    });
  } catch (err) {
    next(err);
  }
});

mcpRouter.get('/running-users', requireApiToken(['read:people', 'read:device-health']), async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      where: {
        workspaceId: workspaceId(req),
        deactivatedAt: null,
        agentState: 'RUNNING',
      },
      select: {
        id: true,
        name: true,
        email: true,
        agentActiveEntryId: true,
        agentLastSeenAt: true,
        agentVersion: true,
        agentPlatform: true,
      },
      orderBy: [{ agentLastSeenAt: 'desc' }, { name: 'asc' }],
      take: MAX_LIMIT,
    });
    res.json({
      users: users.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        activeEntryId: user.agentActiveEntryId,
        lastSeenAt: user.agentLastSeenAt?.toISOString() ?? null,
        version: user.agentVersion,
        platform: user.agentPlatform,
      })),
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
      tz: z.string().trim().min(1).max(80).default('UTC'),
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
    const userIds = users.map((user) => user.id);

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
    const matrix = buildTimesheetMatrix({
      from: query.data.from,
      to: query.data.to,
      tz: query.data.tz,
      segments,
      invalidations,
    });
    if (!matrix) return res.status(400).json({ error: 'invalid_date_range', maxDays: MAX_SUMMARY_DAYS });

    res.json({
      from: matrix.from,
      to: matrix.to,
      tz: matrix.tz,
      users: users.map((user) => {
        const cells = matrix.cells[user.id] ?? {};
        const total = Object.values(cells).reduce(
          (acc, cell) => ({
            workedMs: acc.workedMs + cell.workedMs,
            meetingMs: acc.meetingMs + cell.meetingMs,
            manualMs: acc.manualMs + cell.manualMs,
            invalidatedMs: acc.invalidatedMs + cell.invalidatedMs,
            totalMs: acc.totalMs + cell.totalMs,
          }),
          { workedMs: 0, meetingMs: 0, manualMs: 0, invalidatedMs: 0, totalMs: 0 },
        );
        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          total,
          days: range.days.map((day) => ({
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
          })),
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
      tz: z.string().trim().min(1).max(80).default('UTC'),
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

    res.json({
      requests: requests.map((request) => ({
        id: request.id,
        user: request.user,
        taskGuid: request.larkTaskGuid,
        taskSummary: request.taskSummary,
        requestedStart: request.requestedStart.toISOString(),
        requestedEnd: request.requestedEnd.toISOString(),
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
