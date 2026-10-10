import { prisma } from '@grind/db';
import { dateKeyInTimeZone } from '@grind/types';
import { localDayWindow } from '../insights/day';
import { countedMs, trackingNow } from '@grind/core';
import { loadTimelineWindow, piecesForUser } from '../time';

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
  // Today's counted time from the shared timeline (overlaps once, open ends
  // proven, invalidated time excluded) — the same total every screen shows.
  const timeline = await loadTimelineWindow({ userIds, start: win.start, end: win.end, now });
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
  const today = { start: win.start.getTime(), end: win.end.getTime() };
  const totals = new Map(userIds.map((userId) => [userId, countedMs(piecesForUser(timeline.pieces, userId), today)]));
  const live = trackingNow(timeline.pieces);

  const testers = users.map((u) => {
    const agentLastSeenAt = u.agentLastSeenAt?.toISOString() ?? null;
    const isLiveNow = live.has(u.id);

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
