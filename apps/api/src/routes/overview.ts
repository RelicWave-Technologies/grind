import { Router } from 'express';
import { prisma } from '@grind/db';
import { requireAccessToken } from '../middleware/auth';
import { attachScope, requireManagerOrAbove } from '../middleware/scope';
import { localDayWindow } from '../insights/day';
import { DEFAULT_STUCK_THRESHOLD_MS } from '../digests/pendingDigest';

/**
 * Manager+ workspace overview (M16). One round-trip that powers the
 * /overview landing page — tracked hours today, who's currently
 * active, pending-approval counts (stuck vs fresh), recent flags,
 * recent rejections. Scoped by role: ADMIN sees workspace, MANAGER
 * sees their team's userIds.
 *
 * The dashboard's role-based default landing routes MEMBER to
 * /me-today, MANAGER/ADMIN to /overview — so this is the canonical
 * "command center" view.
 */
export const overviewRouter = Router();
overviewRouter.use(requireAccessToken, attachScope, requireManagerOrAbove);

const HOUR = 60 * 60 * 1000;

interface OverviewRecentItem {
  id: string;
  user: { id: string; name: string };
  reason: string;
  createdAt: string;
  ageMs: number;
  isStuck: boolean;
}

interface OverviewFlagItem {
  id: string;
  user: { id: string; name: string };
  type: string;
  windowStart: string;
  riskScore: number;
  createdAt: string;
}

interface OverviewResponse {
  scope: 'team' | 'workspace';
  generatedAt: string;
  today: {
    date: string;
    tz: string;
    activeUsers: number;
    totalUsers: number;
    workedHours: number;
    meetingHours: number;
    manualHours: number;
  };
  approvals: {
    pendingTotal: number;
    pendingStuck: number;
    oldestPendingAgeMs: number;
    recent: OverviewRecentItem[];
  };
  flags: {
    openTotal: number;
    recent: OverviewFlagItem[];
  };
  recentRejected: Array<{
    id: string;
    user: { id: string; name: string };
    decidedAt: string | null;
    reason: string;
    decidedReason: string | null;
  }>;
}

overviewRouter.get('/', async (req, res, next) => {
  try {
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    if (req.scope.scope === 'self') return res.status(403).json({ error: 'forbidden' });

    const tz = typeof req.query.tz === 'string' && req.query.tz.length > 0 ? req.query.tz : 'UTC';
    const now = new Date();
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .format(now)
      .slice(0, 10);
    const win = localDayWindow(today, tz);
    if (!win) return res.status(400).json({ error: 'invalid_tz' });

    const userIds = req.scope.userIds;
    const ws = req.scope.workspaceId;

    // --- Today's totals (per-user totalMs threshold for "active") --------
    const segs = userIds.length === 0
      ? []
      : await prisma.timeSegment.findMany({
          where: {
            startedAt: { lt: win.end },
            OR: [{ endedAt: null }, { endedAt: { gt: win.start } }],
            timeEntry: { userId: { in: userIds } },
          },
          select: {
            kind: true,
            startedAt: true,
            endedAt: true,
            timeEntry: { select: { userId: true, source: true } },
          },
        });

    const dayStart = win.start.getTime();
    const dayEnd = win.end.getTime();
    const liveCap = Math.min(dayEnd, now.getTime());
    let workedMs = 0;
    let meetingMs = 0;
    let manualMs = 0;
    const usersWithTime = new Set<string>();
    for (const s of segs) {
      const a = Math.max(dayStart, s.startedAt.getTime());
      const b = Math.min(liveCap, (s.endedAt ?? new Date(liveCap)).getTime());
      const dur = b - a;
      if (dur <= 0) continue;
      usersWithTime.add(s.timeEntry.userId);
      if (s.timeEntry.source === 'MANUAL') manualMs += dur;
      else if (s.kind === 'MEETING') meetingMs += dur;
      else if (s.kind === 'WORK') workedMs += dur;
      // IDLE_TRIMMED never counts toward billed time.
    }

    // --- Pending approvals (scoped) --------------------------------------
    const pendingRows = userIds.length === 0
      ? []
      : await prisma.manualTimeRequest.findMany({
          where: { status: 'PENDING', userId: { in: userIds } },
          include: { user: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'asc' },
        });
    const pendingNow = now.getTime();
    let oldestPendingAge = 0;
    let pendingStuck = 0;
    const recentPending: OverviewRecentItem[] = pendingRows.slice(0, 8).map((r) => {
      const ageMs = Math.max(0, pendingNow - r.createdAt.getTime());
      if (ageMs > oldestPendingAge) oldestPendingAge = ageMs;
      const isStuck = ageMs >= DEFAULT_STUCK_THRESHOLD_MS;
      if (isStuck) pendingStuck += 1;
      return {
        id: r.id,
        user: r.user,
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
        ageMs,
        isStuck,
      };
    });
    // Stuck count is across all PENDING rows, not just the 8 we render.
    pendingStuck = pendingRows.reduce((n, r) => {
      return n + (pendingNow - r.createdAt.getTime() >= DEFAULT_STUCK_THRESHOLD_MS ? 1 : 0);
    }, 0);
    if (pendingRows.length > 0) {
      const oldest = Math.max(0, pendingNow - pendingRows[0]!.createdAt.getTime());
      if (oldest > oldestPendingAge) oldestPendingAge = oldest;
    }

    // --- Recent flags ----------------------------------------------------
    const openFlags = userIds.length === 0
      ? []
      : await prisma.activityFlag.findMany({
          where: { status: 'OPEN', userId: { in: userIds } },
          include: { user: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'desc' },
          take: 8,
        });
    const flagCount = userIds.length === 0
      ? 0
      : await prisma.activityFlag.count({ where: { status: 'OPEN', userId: { in: userIds } } });

    // --- Recent rejections (last 5) for the "what's been pushed back" -----
    const rejected = userIds.length === 0
      ? []
      : await prisma.manualTimeRequest.findMany({
          where: { status: 'REJECTED', userId: { in: userIds } },
          include: { user: { select: { id: true, name: true } } },
          orderBy: { decidedAt: 'desc' },
          take: 5,
        });

    // --- Active users tally — userIds.length is "total in scope" --------
    const totalUsers = userIds.length;

    const payload: OverviewResponse = {
      scope: req.scope.scope === 'workspace' ? 'workspace' : 'team',
      generatedAt: now.toISOString(),
      today: {
        date: today,
        tz,
        activeUsers: usersWithTime.size,
        totalUsers,
        workedHours: roundH(workedMs),
        meetingHours: roundH(meetingMs),
        manualHours: roundH(manualMs),
      },
      approvals: {
        pendingTotal: pendingRows.length,
        pendingStuck,
        oldestPendingAgeMs: oldestPendingAge,
        recent: recentPending,
      },
      flags: {
        openTotal: flagCount,
        recent: openFlags.map((f) => ({
          id: f.id,
          user: f.user,
          type: f.type,
          windowStart: f.windowStart.toISOString(),
          riskScore: f.riskScore,
          createdAt: f.createdAt.toISOString(),
        })),
      },
      recentRejected: rejected.map((r) => ({
        id: r.id,
        user: r.user,
        decidedAt: r.decidedAt?.toISOString() ?? null,
        reason: r.reason,
        decidedReason: r.decidedReason,
      })),
    };

    // Workspace id is used implicitly via scope.userIds; suppress unused warning
    void ws;

    res.json(payload);
  } catch (err) {
    next(err);
  }
});

function roundH(ms: number): number {
  return Math.round((ms / HOUR) * 100) / 100;
}

export default overviewRouter;
