import { prisma } from '@grind/db';
import { localDayWindow } from '../insights/day';

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
      larkIdentity: { select: { openId: true } },
    },
    orderBy: { name: 'asc' },
  });
  const entries = await prisma.timeEntry.findMany({
    where: {
      userId: { in: users.map((u) => u.id) },
      startedAt: { lt: win.end },
      OR: [{ endedAt: null }, { endedAt: { gt: win.start } }],
    },
    select: { userId: true, startedAt: true, endedAt: true },
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
  const totals = new Map<string, number>();
  for (const entry of entries) {
    const start = Math.max(entry.startedAt.getTime(), win.start.getTime());
    const end = Math.min((entry.endedAt ?? now).getTime(), win.end.getTime(), now.getTime());
    if (end > start) totals.set(entry.userId, (totals.get(entry.userId) ?? 0) + end - start);
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
