import { prisma } from '@grind/db';
import { dateKeyInTimeZone } from '@grind/types';
import { localDayWindow } from '../insights/day';
import { collectEffectiveIntervals, intervalUnionMs, type EffectiveInterval } from '../insights/effectiveIntervals';
import { loadEntryLiveEvidence, LIVE_HEARTBEAT_FRESH_MS } from '../insights/liveEntryEvidence';

export async function buildTesterUsageSnapshot(workspaceId: string, timezone: string) {
  const now = new Date();
  const date = dateKeyInTimeZone(now, timezone);
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
      endedAt: true,
      trackingProtocolVersion: true,
      lastProvenAt: true,
      leaseExpiresAt: true,
      segments: { select: { kind: true, startedAt: true, endedAt: true } },
    },
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
  const evidenceByEntry = await loadEntryLiveEvidence(entries, now);
  const intervalsByUser = new Map<string, EffectiveInterval[]>();
  for (const entry of entries) {
    const intervals = collectEffectiveIntervals(entry, {
      now,
      windowStart: win.start.getTime(),
      windowEnd: win.end.getTime(),
      evidenceByEntry,
      includeSegment: (segment) => entry.source === 'MANUAL' || segment.kind !== 'IDLE_TRIMMED',
    });
    const existing = intervalsByUser.get(entry.userId) ?? [];
    existing.push(...intervals);
    intervalsByUser.set(entry.userId, existing);
  }
  const totals = new Map(
    Array.from(intervalsByUser.entries()).map(([userId, intervals]) => [userId, intervalUnionMs(intervals)]),
  );

  const testers = users.map((u) => {
    const lastSeen = u.agentLastSeenAt;
    const agentLastSeenAt = lastSeen?.toISOString() ?? null;
    const isLiveNow = u.agentState === 'RUNNING'
      && lastSeen !== null
      && now.getTime() - lastSeen.getTime() <= LIVE_HEARTBEAT_FRESH_MS;

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
