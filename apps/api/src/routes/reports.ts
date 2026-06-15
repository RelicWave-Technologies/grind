import crypto from 'crypto';
import { Router, type Request } from 'express';
import { prisma } from '@grind/db';
import type {
  ManualTimeRequestDto,
  MemberReportDayAppsResponse,
  MemberReportDayScreenshotsResponse,
  MemberReportsMeResponse,
  TeamMemberReportsResponse,
  TeamReportUser,
} from '@grind/types';
import { requireAccessToken } from '../middleware/auth';
import { attachScope, requireCapability } from '../middleware/scope';
import { env } from '../env';
import {
  buildMemberReportApps,
  buildMemberReportDays,
  buildMemberReportScreenshots,
  resolveReportRange,
  resolveSingleReportDay,
  type ReportActivitySample,
  type ReportManualRequest,
  type ReportRange,
  type ReportShiftAssignment,
  type ReportScreenshotRow,
  type ReportTimeEntry,
} from '../reports/member';
import { buildTeamReportsResponse } from '../reports/team';
import { loadProfileForUser } from '../profile/service';
import { resolveAppIcon, storedIconDataUrls } from '../insights/appIcon';
import type { IconResolver } from '../reports/member';

export const reportsRouter = Router();
reportsRouter.use(requireAccessToken, attachScope, requireCapability('reports.self.read'));

const TEAM_REPORT_MAX_DAYS = 31;

/** Build an icon resolver that prefers real agent-extracted icons (data URLs)
 *  for the bundles seen in these samples, falling back to the brand map. */
async function iconForSamples(samples: { activeAppBundle: string | null }[]): Promise<IconResolver> {
  const stored = await storedIconDataUrls(samples.map((s) => s.activeAppBundle));
  return (app, bundle) => resolveAppIcon(app, bundle, stored);
}

reportsRouter.get('/me', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const range = resolveReportRange(req.query as Record<string, unknown>);
    if ('error' in range) return res.status(range.status).json({ error: range.error, ...(range.extras ?? {}) });

    const data = await loadReportData(req.user.sub, range);
    const iconFor = await iconForSamples(data.samples);
    const response: MemberReportsMeResponse = {
      from: range.from,
      to: range.to,
      tz: range.tz,
      days: buildMemberReportDays({
        userId: req.user.sub,
        range,
        now: new Date(),
        entries: data.entries,
        manualRequests: data.manualRequests,
        samples: data.samples,
        screenshots: data.screenshots,
        shiftAssignments: data.shiftAssignments,
        iconFor,
      }),
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

reportsRouter.get('/team', requireCapability('reports.team.read'), async (req, res, next) => {
  try {
    if (!req.user || !req.scope) return res.status(401).json({ error: 'unauthorized' });
    const range = resolveReportRange(req.query as Record<string, unknown>);
    if ('error' in range) return res.status(range.status).json({ error: range.error, ...(range.extras ?? {}) });
    if (range.days.length > TEAM_REPORT_MAX_DAYS) {
      return res.status(400).json({ error: 'range_too_long', maxDays: TEAM_REPORT_MAX_DAYS });
    }

    const scopedUserIds = req.scope.userIds.filter((id) => id !== req.user!.sub);
    const users = scopedUserIds.length > 0
      ? await prisma.user.findMany({
          where: {
            id: { in: scopedUserIds },
            workspaceId: req.user.ws,
            deactivatedAt: null,
          },
          select: {
            id: true,
            name: true,
            email: true,
            avatarUrl: true,
            teamId: true,
            team: { select: { name: true } },
          },
          orderBy: [{ name: 'asc' }, { email: 'asc' }],
        })
      : [];
    const reportUsers: TeamReportUser[] = users.map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      avatarUrl: u.avatarUrl,
      teamId: u.teamId,
      teamName: u.team?.name ?? null,
    }));

    const reportData = await loadTeamReportData(reportUsers.map((u) => u.id), range);
    const iconFor = await iconForSamples([...reportData.values()].flatMap((d) => d.samples));
    const daysByUser = new Map<string, ReturnType<typeof buildMemberReportDays>>();
    const now = new Date();
    for (const user of reportUsers) {
      const data = reportData.get(user.id) ?? emptyTeamReportData();
      daysByUser.set(user.id, buildMemberReportDays({
        userId: user.id,
        range,
        now,
        entries: data.entries,
        manualRequests: data.manualRequests,
        samples: data.samples,
        screenshots: data.screenshots,
        shiftAssignments: data.shiftAssignments,
        iconFor,
      }));
    }

    res.json(buildTeamReportsResponse({ range, users: reportUsers, daysByUser }));
  } catch (err) {
    next(err);
  }
});

reportsRouter.get('/team/member', requireCapability('reports.team.read'), async (req, res, next) => {
  try {
    if (!req.user || !req.scope) return res.status(401).json({ error: 'unauthorized' });
    const target = await resolveScopedReportUser(req, req.query.userId);
    if (!target.ok) return res.status(target.status).json({ error: target.error });

    const range = resolveReportRange(req.query as Record<string, unknown>);
    if ('error' in range) return res.status(range.status).json({ error: range.error, ...(range.extras ?? {}) });

    const [profile, reportData, approvals] = await Promise.all([
      loadProfileForUser(target.user.id, req.user.ws),
      loadTeamReportData([target.user.id], range),
      loadManualRequestsForUser(target.user.id, range),
    ]);
    if (!profile) return res.status(404).json({ error: 'user_not_found' });
    if ('error' in profile) return res.status(503).json({ error: profile.error });

    const data = reportData.get(target.user.id) ?? emptyTeamReportData();
    const iconFor = await iconForSamples(data.samples);
    const days = buildMemberReportDays({
      userId: target.user.id,
      range,
      now: new Date(),
      entries: data.entries,
      manualRequests: data.manualRequests,
      samples: data.samples,
      screenshots: data.screenshots,
      shiftAssignments: data.shiftAssignments,
      iconFor,
    });
    const teamReport = buildTeamReportsResponse({
      range,
      users: [target.user],
      daysByUser: new Map([[target.user.id, days]]),
    });
    const member = teamReport.members[0];
    if (!member) return res.status(404).json({ error: 'user_not_found' });

    const response: TeamMemberReportsResponse = {
      from: range.from,
      to: range.to,
      tz: range.tz,
      days: range.days,
      member,
      approvals,
      profile,
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

reportsRouter.get('/team/member/day-apps', requireCapability('reports.team.read'), async (req, res, next) => {
  try {
    if (!req.user || !req.scope) return res.status(401).json({ error: 'unauthorized' });
    const target = await resolveScopedReportUser(req, req.query.userId);
    if (!target.ok) return res.status(target.status).json({ error: target.error });
    const range = resolveSingleReportDay(req.query as Record<string, unknown>);
    if ('error' in range) return res.status(range.status).json({ error: range.error, ...(range.extras ?? {}) });
    const samples = await loadSamples(target.user.id, range);
    const response: MemberReportDayAppsResponse = buildMemberReportApps({ range, samples, iconFor: await iconForSamples(samples) });
    res.json(response);
  } catch (err) {
    next(err);
  }
});

reportsRouter.get('/team/member/day-screenshots', requireCapability('reports.team.read'), async (req, res, next) => {
  try {
    if (!req.user || !req.scope) return res.status(401).json({ error: 'unauthorized' });
    const target = await resolveScopedReportUser(req, req.query.userId);
    if (!target.ok) return res.status(target.status).json({ error: target.error });
    const range = resolveSingleReportDay(req.query as Record<string, unknown>);
    if ('error' in range) return res.status(range.status).json({ error: range.error, ...(range.extras ?? {}) });
    const [samples, screenshots] = await Promise.all([
      loadSamples(target.user.id, range),
      loadScreenshots(target.user.id, range),
    ]);
    const response: MemberReportDayScreenshotsResponse = buildMemberReportScreenshots({
      range,
      samples,
      screenshots,
      toUrl: screenshotUrl,
    });
    res.json(response);
  } catch (err) {
    next(err);
  }
});

reportsRouter.get('/me/day-apps', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const range = resolveSingleReportDay(req.query as Record<string, unknown>);
    if ('error' in range) return res.status(range.status).json({ error: range.error, ...(range.extras ?? {}) });
    const samples = await loadSamples(req.user.sub, range);
    const response: MemberReportDayAppsResponse = buildMemberReportApps({ range, samples, iconFor: await iconForSamples(samples) });
    res.json(response);
  } catch (err) {
    next(err);
  }
});

async function resolveScopedReportUser(
  req: Request,
  rawUserId: unknown,
): Promise<
  | { ok: true; user: TeamReportUser }
  | { ok: false; status: 400 | 401 | 403 | 404; error: string }
> {
  if (!req.user || !req.scope) return { ok: false, status: 401, error: 'unauthorized' };
  if (typeof rawUserId !== 'string' || rawUserId.trim().length === 0) {
    return { ok: false, status: 400, error: 'missing_user_id' };
  }
  const userId = rawUserId.trim();
  if (!req.scope.userIds.includes(userId)) {
    return { ok: false, status: 403, error: 'forbidden' };
  }
  const user = await prisma.user.findFirst({
    where: {
      id: userId,
      workspaceId: req.user.ws,
      deactivatedAt: null,
    },
    select: {
      id: true,
      name: true,
      email: true,
      avatarUrl: true,
      teamId: true,
      team: { select: { name: true } },
    },
  });
  if (!user) return { ok: false, status: 404, error: 'user_not_found' };
  return {
    ok: true,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      avatarUrl: user.avatarUrl,
      teamId: user.teamId,
      teamName: user.team?.name ?? null,
    },
  };
}

async function loadManualRequestsForUser(
  userId: string,
  range: ReportRange,
): Promise<ManualTimeRequestDto[]> {
  const rows = await prisma.manualTimeRequest.findMany({
    where: {
      userId,
      requestedStart: { lt: range.rangeEnd },
      requestedEnd: { gt: range.rangeStart },
      status: { in: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] },
    },
    orderBy: [{ requestedStart: 'desc' }, { createdAt: 'desc' }],
    take: 200,
    select: {
      id: true,
      clientUuid: true,
      userId: true,
      approverId: true,
      larkTaskGuid: true,
      taskSummary: true,
      larkMessageId: true,
      requestedStart: true,
      requestedEnd: true,
      reason: true,
      status: true,
      autoApproved: true,
      decidedAt: true,
      decidedReason: true,
      createdAt: true,
      attendees: { select: { userId: true } },
      user: { select: { id: true, name: true, email: true, avatarUrl: true } },
      approver: { select: { id: true, name: true, email: true, avatarUrl: true } },
    },
  });
  return rows.map((row) => ({
    id: row.id,
    clientUuid: row.clientUuid,
    userId: row.userId,
    approverId: row.approverId,
    larkTaskGuid: row.larkTaskGuid,
    taskSummary: row.taskSummary ?? null,
    larkMessageId: row.larkMessageId,
    requestedStart: row.requestedStart.toISOString(),
    requestedEnd: row.requestedEnd.toISOString(),
    reason: row.reason,
    status: row.status,
    autoApproved: row.autoApproved,
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    decidedReason: row.decidedReason,
    createdAt: row.createdAt.toISOString(),
    attendeeIds: row.attendees.map((a) => a.userId),
    user: row.user,
    approver: row.approver,
  }));
}

reportsRouter.get('/me/day-screenshots', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const range = resolveSingleReportDay(req.query as Record<string, unknown>);
    if ('error' in range) return res.status(range.status).json({ error: range.error, ...(range.extras ?? {}) });
    const [samples, screenshots] = await Promise.all([
      loadSamples(req.user.sub, range),
      loadScreenshots(req.user.sub, range),
    ]);
    const response: MemberReportDayScreenshotsResponse = buildMemberReportScreenshots({
      range,
      samples,
      screenshots,
      toUrl: screenshotUrl,
    });
    res.json(response);
  } catch (err) {
    next(err);
  }
});

async function loadReportData(userId: string, range: ReportRange) {
  const [entries, manualRequests, samples, screenshots, shiftAssignments] = await Promise.all([
    prisma.timeEntry.findMany({
      where: {
        userId,
        startedAt: { lt: range.rangeEnd },
        OR: [{ endedAt: null }, { endedAt: { gt: range.rangeStart } }],
      },
      select: {
        id: true,
        userId: true,
        source: true,
        larkTaskGuid: true,
        notes: true,
        segments: {
          select: { kind: true, startedAt: true, endedAt: true },
          orderBy: { startedAt: 'asc' },
        },
        attendees: { select: { userId: true } },
      },
      orderBy: { startedAt: 'asc' },
    }),
    prisma.manualTimeRequest.findMany({
      where: {
        userId,
        requestedStart: { lt: range.rangeEnd },
        requestedEnd: { gt: range.rangeStart },
        status: { in: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] },
      },
      select: {
        id: true,
        status: true,
        requestedStart: true,
        requestedEnd: true,
        reason: true,
        larkTaskGuid: true,
        decidedReason: true,
        attendees: { select: { userId: true } },
      },
    }),
    loadSamples(userId, range),
    loadScreenshots(userId, range),
    prisma.shiftAssignment.findMany({
      where: {
        userId,
        effectiveFrom: { lt: range.rangeEnd },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: range.rangeStart } }],
      },
      select: {
        shiftId: true,
        effectiveFrom: true,
        effectiveTo: true,
        shiftNameSnapshot: true,
        scheduleSnapshot: true,
        bufferMinSnapshot: true,
      },
      orderBy: { effectiveFrom: 'asc' },
    }),
  ]);
  return {
    entries: entries.map((e) => ({
      ...e,
      source: e.source as 'AUTO' | 'MANUAL',
      segments: e.segments.map((s) => ({
        ...s,
        kind: s.kind as 'WORK' | 'MEETING' | 'IDLE_TRIMMED',
      })),
    })),
    manualRequests,
    samples,
    screenshots,
    shiftAssignments,
  };
}

interface TeamReportDataBucket {
  entries: ReportTimeEntry[];
  manualRequests: ReportManualRequest[];
  samples: ReportActivitySample[];
  screenshots: ReportScreenshotRow[];
  shiftAssignments: ReportShiftAssignment[];
}

function emptyTeamReportData(): TeamReportDataBucket {
  return {
    entries: [],
    manualRequests: [],
    samples: [],
    screenshots: [],
    shiftAssignments: [],
  };
}

async function loadTeamReportData(userIds: string[], range: ReportRange): Promise<Map<string, TeamReportDataBucket>> {
  const grouped = new Map<string, TeamReportDataBucket>();
  for (const userId of userIds) grouped.set(userId, emptyTeamReportData());
  if (userIds.length === 0) return grouped;

  const [entries, manualRequests, samples, screenshots, shiftAssignments] = await Promise.all([
    prisma.timeEntry.findMany({
      where: {
        userId: { in: userIds },
        startedAt: { lt: range.rangeEnd },
        OR: [{ endedAt: null }, { endedAt: { gt: range.rangeStart } }],
      },
      select: {
        id: true,
        userId: true,
        source: true,
        larkTaskGuid: true,
        notes: true,
        segments: {
          select: { kind: true, startedAt: true, endedAt: true },
          orderBy: { startedAt: 'asc' },
        },
        attendees: { select: { userId: true } },
      },
      orderBy: [{ userId: 'asc' }, { startedAt: 'asc' }],
    }),
    prisma.manualTimeRequest.findMany({
      where: {
        userId: { in: userIds },
        requestedStart: { lt: range.rangeEnd },
        requestedEnd: { gt: range.rangeStart },
        status: { in: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] },
      },
      select: {
        userId: true,
        id: true,
        status: true,
        requestedStart: true,
        requestedEnd: true,
        reason: true,
        larkTaskGuid: true,
        decidedReason: true,
        attendees: { select: { userId: true } },
      },
    }),
    prisma.activitySample.findMany({
      where: {
        userId: { in: userIds },
        bucketStart: { gte: range.rangeStart, lt: range.rangeEnd },
      },
      select: {
        userId: true,
        bucketStart: true,
        keystrokes: true,
        clicks: true,
        scrollEvents: true,
        mouseDistancePx: true,
        activeApp: true,
        activeAppBundle: true,
      },
      orderBy: [{ userId: 'asc' }, { bucketStart: 'asc' }],
    }),
    prisma.screenshot.findMany({
      where: {
        userId: { in: userIds },
        uploadState: 'UPLOADED',
        deletedAt: null,
        capturedAt: { gte: range.rangeStart, lt: range.rangeEnd },
      },
      select: {
        userId: true,
        id: true,
        timeEntryId: true,
        displayId: true,
        capturedAt: true,
        s3Key: true,
        thumbS3Key: true,
        fullUrl: true,
        thumbUrl: true,
        bytes: true,
        width: true,
        height: true,
        blurred: true,
      },
      orderBy: [{ userId: 'asc' }, { capturedAt: 'asc' }],
    }),
    prisma.shiftAssignment.findMany({
      where: {
        userId: { in: userIds },
        effectiveFrom: { lt: range.rangeEnd },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: range.rangeStart } }],
      },
      select: {
        userId: true,
        shiftId: true,
        effectiveFrom: true,
        effectiveTo: true,
        shiftNameSnapshot: true,
        scheduleSnapshot: true,
        bufferMinSnapshot: true,
      },
      orderBy: [{ userId: 'asc' }, { effectiveFrom: 'asc' }],
    }),
  ]);

  for (const entry of entries) {
    grouped.get(entry.userId)?.entries.push({
      ...entry,
      source: entry.source as 'AUTO' | 'MANUAL',
      segments: entry.segments.map((s) => ({
        ...s,
        kind: s.kind as 'WORK' | 'MEETING' | 'IDLE_TRIMMED',
      })),
    });
  }
  for (const row of manualRequests) {
    const { userId, ...request } = row;
    grouped.get(userId)?.manualRequests.push(request);
  }
  for (const row of samples) {
    const { userId, ...sample } = row;
    grouped.get(userId)?.samples.push(sample);
  }
  for (const row of screenshots) {
    const { userId, ...screenshot } = row;
    grouped.get(userId)?.screenshots.push(screenshot);
  }
  for (const row of shiftAssignments) {
    const { userId, ...assignment } = row;
    grouped.get(userId)?.shiftAssignments.push(assignment);
  }
  return grouped;
}

async function loadSamples(userId: string, range: ReportRange): Promise<ReportActivitySample[]> {
  return prisma.activitySample.findMany({
    where: {
      userId,
      bucketStart: { gte: range.rangeStart, lt: range.rangeEnd },
    },
    select: {
      bucketStart: true,
      keystrokes: true,
      clicks: true,
      scrollEvents: true,
      mouseDistancePx: true,
      activeApp: true,
      activeAppBundle: true,
    },
    orderBy: { bucketStart: 'asc' },
  });
}

async function loadScreenshots(userId: string, range: ReportRange): Promise<ReportScreenshotRow[]> {
  return prisma.screenshot.findMany({
    where: {
      userId,
      uploadState: 'UPLOADED',
      deletedAt: null,
      capturedAt: { gte: range.rangeStart, lt: range.rangeEnd },
    },
    select: {
      id: true,
      timeEntryId: true,
      displayId: true,
      capturedAt: true,
      s3Key: true,
      thumbS3Key: true,
      fullUrl: true,
      thumbUrl: true,
      bytes: true,
      width: true,
      height: true,
      blurred: true,
    },
    orderBy: { capturedAt: 'asc' },
  });
}

function screenshotUrl(row: ReportScreenshotRow, variant: 'full' | 'thumb'): string | null {
  const direct = variant === 'thumb' ? row.thumbUrl : row.fullUrl;
  if (direct) return direct;
  const key = variant === 'thumb' ? row.thumbS3Key : row.s3Key;
  if (!key || !env.SCREENSHOT_ASSET_BASE_URL) return null;
  const expires = Math.floor(Date.now() / 1000) + 10 * 60;
  const url = new URL(env.SCREENSHOT_ASSET_BASE_URL);
  url.pathname = `${url.pathname.replace(/\/$/u, '')}/${encodeKeyPath(key)}`;
  if (env.SCREENSHOT_URL_SIGNING_SECRET) {
    const sig = crypto
      .createHmac('sha256', env.SCREENSHOT_URL_SIGNING_SECRET)
      .update(`${key}:${expires}`)
      .digest('hex');
    url.searchParams.set('expires', String(expires));
    url.searchParams.set('sig', sig);
  }
  return url.toString();
}

function encodeKeyPath(key: string): string {
  return key.split('/').map((part) => encodeURIComponent(part)).join('/');
}

export default reportsRouter;
