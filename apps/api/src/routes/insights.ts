import { Router } from 'express';
import { prisma } from '@grind/db';
import { requireAccessToken } from '../middleware/auth';
import { scoreDay } from '../scoring/score';
import { assessWindow, type RiskSample } from '../anticheat/risk';
import type { RoleTitle } from '../scoring/presets';

export const insightsRouter = Router();
insightsRouter.use(requireAccessToken);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parse YYYY-MM-DD as a UTC day window; default to today (UTC). */
function dayWindow(day?: string): { start: Date; end: Date } | null {
  const base = day ? new Date(`${day}T00:00:00.000Z`) : new Date();
  if (Number.isNaN(base.getTime())) return null;
  const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/**
 * Productivity score + anti-cheat assessment for one user-day, computed live
 * from stored per-minute activity samples. Self-only for now (MEMBER scope);
 * manager/admin team scoping arrives with the dashboard (M11).
 *
 * NOTE: samples don't yet carry meeting/role context, so scoring uses the
 * OTHER preset and treats no minute as a protected meeting — both refinements
 * land when roleTitle + isProtectedMeeting are persisted.
 */
insightsRouter.get('/score', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const win = dayWindow(typeof req.query.day === 'string' ? req.query.day : undefined);
    if (!win) return res.status(400).json({ error: 'invalid_day' });

    const samples = await prisma.activitySample.findMany({
      where: { userId: req.user.sub, bucketStart: { gte: win.start, lt: win.end } },
      orderBy: { bucketStart: 'asc' },
      select: {
        keystrokes: true,
        clicks: true,
        scrollEvents: true,
        mouseDistancePx: true,
        ikiCv: true,
        moveSpeedCv: true,
        pathStraightness: true,
      },
    });

    const role: RoleTitle = 'OTHER';
    const day = scoreDay(samples, { role });
    const anticheat = assessWindow(samples as RiskSample[]);

    res.json({
      day: win.start.toISOString().slice(0, 10),
      role,
      score: day,
      anticheat: { hardReject: anticheat.hardReject, riskScore: anticheat.riskScore, flags: anticheat.flags },
    });
  } catch (err) {
    next(err);
  }
});

export default insightsRouter;
