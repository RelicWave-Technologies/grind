import { prisma } from '@grind/db';
import { localDayWindow } from '../insights/day';
import { latestSampleByEntry, latestScreenshotByEntry, resolveEffectiveSegmentEnd } from '../insights/openSegmentEvidence';

const AGENT_HEARTBEAT_FRESH_MS = 3 * 60 * 1000;

export async function buildTesterUsageSnapshot(workspaceId: string, timezone: string) {
  const now = new Date();
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(now);
  const win = localDayWindow(date, timezone);
  if (!win) throw new Error('invalid_timezone');

  const users = await prisma.user.findMany({
    where: { workspaceId, deactivatedAt: null },
    select: {
      id: true,
      name: true,
      avatarUrl: true,
      agentState: true,
      agentLastSeenAt: true,
      agentActiveEntryId: true,
      larkIdentity: { select: { openId: true } },
    },
    orderBy: { name: 'asc' },
  });
  const userIds = users.map((u) => u.id);
  const entries = await prisma.timeEntry.findMany({
    where: {
      userId: { in: userIds },
      startedAt: { lt: win.end },
      OR: [{ endedAt: null }, { endedAt: { gt: win.start } }],
    },
    select: {
      id: true,
      userId: true,
      source: true,
      trackingProtocolVersion: true,
      lastProvenAt: true,
      leaseExpiresAt: true,
      screenshots: {
        where: { deletedAt: null },
        orderBy: { capturedAt: 'desc' },
        take: 1,
        select: { capturedAt: true },
      },
      segments: { select: { kind: true, startedAt: true, endedAt: true } },
    },
  });
  const activitySamples = userIds.length === 0
    ? []
    : await prisma.activitySample.findMany({
        where: {
          userId: { in: userIds },
          bucketStart: { gte: win.start, lt: win.end },
        },
        select: { timeEntryId: true, bucketStart: true },
        orderBy: { bucketStart: 'asc' },
      });
  const screenshots = await prisma.screenshot.groupBy({
    by: ['userId'],
    where: {
      userId: { in: users.map((u) => u.id) },
      capturedAt: { gte: win.start, lt: win.end },
      deletedAt: null,
    },
    _count: { _all: true },
  });

  const screenshotCount = new Map(screenshots.map((s) => [s.userId, s._count._all]));
  const latestSampleAt = latestSampleByEntry(activitySamples);
  const latestScreenshotAt = latestScreenshotByEntry(entries.flatMap((entry) =>
    entry.screenshots.map((screenshot) => ({ timeEntryId: entry.id, capturedAt: screenshot.capturedAt })),
  ));
  const latestHeartbeatAt = new Map<string, Date>();
  for (const user of users) {
    if (user.agentState === 'RUNNING' && user.agentActiveEntryId && user.agentLastSeenAt) {
      latestHeartbeatAt.set(user.agentActiveEntryId, user.agentLastSeenAt);
    }
  }
  const totals = new Map<string, number>();
  for (const entry of entries) {
    for (const segment of entry.segments) {
      if (entry.source !== 'MANUAL' && segment.kind === 'IDLE_TRIMMED') continue;
      const start = Math.max(segment.startedAt.getTime(), win.start.getTime());
      const effectiveEndedAt = resolveEffectiveSegmentEnd({
        startedAt: segment.startedAt,
        endedAt: segment.endedAt,
        now,
        latestSampleAt: latestSampleAt.get(entry.id),
        latestScreenshotAt: latestScreenshotAt.get(entry.id),
        latestHeartbeatAt: latestHeartbeatAt.get(entry.id),
        lifecycle: entry,
      });
      const end = Math.min(
        (effectiveEndedAt ?? now).getTime(),
        win.end.getTime(),
        now.getTime(),
      );
      if (end > start) totals.set(entry.userId, (totals.get(entry.userId) ?? 0) + end - start);
    }
  }

  const testers = users.map((u) => {
    const lastSeen = u.agentLastSeenAt;
    const agentLastSeenAt = lastSeen?.toISOString() ?? null;
    const isLiveNow = u.agentState === 'RUNNING'
      && lastSeen !== null
      && now.getTime() - lastSeen.getTime() <= AGENT_HEARTBEAT_FRESH_MS;

    return {
      userId: u.id,
      name: u.name,
      avatarUrl: u.avatarUrl,
      openId: u.larkIdentity?.openId ?? null,
      trackedMinutes: Math.round((totals.get(u.id) ?? 0) / 60000),
      screenshots: screenshotCount.get(u.id) ?? 0,
      agentState: u.agentState,
      agentLastSeenAt,
      isLiveNow,
    };
  });

  return {
    generatedAt: now.toISOString(),
    date,
    timezone,
    totals: {
      testers: testers.length,
      trackingNow: testers.filter((t) => t.isLiveNow).length,
      silent: testers.filter((t) => !t.isLiveNow && t.trackedMinutes === 0 && t.screenshots === 0).length,
    },
    testers,
  };
}
