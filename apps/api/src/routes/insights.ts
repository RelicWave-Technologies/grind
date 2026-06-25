import { Router } from 'express';
import { prisma } from '@grind/db';
import { requireAccessToken } from '../middleware/auth';
import { attachScope } from '../middleware/scope';
import { scoreDay } from '../scoring/score';
import { assessWindow, type RiskSample } from '../anticheat/risk';
import type { RoleTitle } from '../scoring/presets';
import { buildDayInsight, localDayWindow, shiftDayWindow } from '../insights/day';
import { cappedOpenEndedAt, latestSampleByEntry } from '../insights/openSegmentEvidence';
import { WEEKDAYS, type ShiftSchedule } from '@grind/types';
import { buildHeatmap, DEFAULT_BUCKET_MS, type HeatmapSample } from '../insights/heatmap';
import { buildAppUsage } from '../insights/appUsage';
import { resolveAppIcon, storedIconDataUrls } from '../insights/appIcon';

export const insightsRouter = Router();
// /day accepts an optional ?userId= so admins/managers can pull a team
// member's timesheet — attachScope resolves the visible userIds. /score
// remains self-only for now (caller can only see their own productivity).
insightsRouter.use(requireAccessToken, attachScope);

/**
 * Resolve the target userId for a "view someone's day" request. Defaults to
 * the caller; rejects if the caller isn't permitted to view that user.
 */
function resolveTargetUserId(req: { user?: { sub: string }; scope?: { userIds: string[] } }, raw: unknown): { ok: true; userId: string } | { ok: false; status: number; error: string } {
  if (!req.user) return { ok: false, status: 401, error: 'unauthorized' };
  if (typeof raw !== 'string' || raw.length === 0) return { ok: true, userId: req.user.sub };
  if (!req.scope) return { ok: false, status: 500, error: 'scope_unresolved' };
  if (!req.scope.userIds.includes(raw)) return { ok: false, status: 403, error: 'forbidden' };
  return { ok: true, userId: raw };
}

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
        bucketStart: true,
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

    // Day totals + per-hour keystrokes (for the Reports chart).
    const totals = { keystrokes: 0, clicks: 0, mouseDistancePx: 0, scrollEvents: 0 };
    const byHour = Array.from({ length: 24 }, () => 0);
    for (const s of samples) {
      totals.keystrokes += s.keystrokes;
      totals.clicks += s.clicks;
      totals.mouseDistancePx += s.mouseDistancePx;
      totals.scrollEvents += s.scrollEvents;
      byHour[new Date(s.bucketStart).getUTCHours()]! += s.keystrokes + s.clicks;
    }

    res.json({
      day: win.start.toISOString().slice(0, 10),
      role,
      score: day,
      totals,
      byHour,
      anticheat: { hardReject: anticheat.hardReject, riskScore: anticheat.riskScore, flags: anticheat.flags },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /v1/insights/day?date=YYYY-MM-DD&tz=IANA
 *
 * Powers the "Edit Time" tab. Returns the user's per-day timeline as a list
 * of mutually-disjoint, kind-tagged blocks (WORK / MEETING / IDLE_TRIMMED /
 * MANUAL / GAP), already clipped to the local-day window and DST-correct.
 * Also surfaces PENDING ManualTimeRequests overlapping the day so the UI can
 * render a striped overlay (and prevent the user from double-requesting).
 *
 * Self-scope only for now. Manager/admin team-scoped views land with M11.
 */
insightsRouter.get('/day', async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const date = typeof req.query.date === 'string' ? req.query.date : new Date().toISOString().slice(0, 10);
    const tz = typeof req.query.tz === 'string' && req.query.tz.length > 0 ? req.query.tz : 'UTC';
    const win = localDayWindow(date, tz);
    if (!win) return res.status(400).json({ error: 'invalid_date_or_tz' });

    const targetUser = resolveTargetUserId(req, req.query.userId);
    if (!targetUser.ok) return res.status(targetUser.status).json({ error: targetUser.error });
    const userId = targetUser.userId;

    const now = new Date();

    // Resolve the day's frame from the user's shift: [shiftStart, shiftEnd] for
    // the weekday, or the full calendar day when there's no shift / it's a day
    // off. We still QUERY against the full calendar day (`win`) so any work that
    // happened outside the shift is fetched — the builder expands the frame to
    // include it rather than hiding it.
    const userRow = await prisma.user.findUnique({
      where: { id: userId },
      select: { shift: { select: { name: true, schedule: true } } },
    });
    const schedule = (userRow?.shift?.schedule as ShiftSchedule | null | undefined) ?? null;
    const shiftWin = schedule ? shiftDayWindow(date, tz, schedule) : null;
    const frame = shiftWin ?? win;
    let shiftLabel: { name: string; start: string; end: string } | null = null;
    if (shiftWin && schedule && userRow?.shift) {
      const [yy, mm, dd] = date.split('-').map((n) => parseInt(n, 10));
      const weekday = WEEKDAYS[new Date(Date.UTC(yy!, mm! - 1, dd!)).getUTCDay()]!;
      const day = schedule[weekday];
      if (day) shiftLabel = { name: userRow.shift.name, start: day.start, end: day.end };
    }

    // Pull every TimeEntry that overlaps the window, including its segments.
    const entries = await prisma.timeEntry.findMany({
      where: {
        userId,
        startedAt: { lt: win.end },
        OR: [{ endedAt: null }, { endedAt: { gt: win.start } }],
      },
      include: {
        segments: { orderBy: { startedAt: 'asc' } },
        attendees: { select: { userId: true } },
        manualTimeRequest: { select: { id: true } },
      },
      orderBy: { startedAt: 'asc' },
    });

    // PENDING manual requests overlapping the window (for the stripe overlay).
    const pending = await prisma.manualTimeRequest.findMany({
      where: {
        userId,
        status: 'PENDING',
        requestedStart: { lt: win.end },
        requestedEnd: { gt: win.start },
      },
      include: { attendees: { select: { userId: true } } },
      orderBy: { requestedStart: 'asc' },
    });

    // REJECTED requests in the same window — rendered as red rows in the
    // Edit Time table so the user sees why and can re-request.
    const rejected = await prisma.manualTimeRequest.findMany({
      where: {
        userId,
        status: 'REJECTED',
        requestedStart: { lt: win.end },
        requestedEnd: { gt: win.start },
      },
      orderBy: { requestedStart: 'asc' },
    });

    const samples = await prisma.activitySample.findMany({
      where: {
        userId,
        bucketStart: { gte: win.start, lt: win.end },
      },
      select: {
        timeEntryId: true,
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
    const latestSampleAt = latestSampleByEntry(samples);
    const insightEntries = entries.map((e) => ({
      id: e.id,
      source: e.source as 'AUTO' | 'MANUAL',
      requestId: e.manualTimeRequest?.id ?? null,
      larkTaskGuid: e.larkTaskGuid,
      notes: e.notes ?? null,
      attendeeIds: e.attendees.map((a) => a.userId),
      segments: e.segments.map((s) => ({
        kind: s.kind as 'WORK' | 'MEETING' | 'IDLE_TRIMMED',
        startedAt: s.startedAt,
        endedAt: cappedOpenEndedAt({
          startedAt: s.startedAt,
          endedAt: s.endedAt,
          now,
          latestSampleAt: latestSampleAt.get(e.id),
        }),
      })),
    }));

    const result = buildDayInsight({
      date,
      tz,
      now,
      window: frame,
      calendarDay: win,
      shift: shiftLabel,
      entries: insightEntries,
      pending: pending.map((p) => ({
        id: p.id,
        requestedStart: p.requestedStart,
        requestedEnd: p.requestedEnd,
        reason: p.reason,
        larkTaskGuid: p.larkTaskGuid,
        taskSummary: p.taskSummary,
        attendeeIds: p.attendees.map((a) => a.userId),
      })),
      rejected: rejected.map((r) => ({
        id: r.id,
        requestedStart: r.requestedStart,
        requestedEnd: r.requestedEnd,
        reason: r.reason,
        decidedReason: r.decidedReason,
        larkTaskGuid: r.larkTaskGuid,
        taskSummary: r.taskSummary,
      })),
    });

    // Activity heatmap: 10-min productivity buckets across the day window.
    // Averages scoreMinute() per bucket. Returns null where no samples landed
    // — distinct from "samples scored 0" (idle) so the dashboard can render
    // dead air differently. The
    // schema doesn't (yet) carry isProtectedMeeting on each sample — we
    // derive it post-hoc by checking whether the minute overlaps a
    // MEETING segment in the entries we already fetched. Cheap because
    // both lists are sorted + small.
    const meetingIntervals: Array<{ a: number; b: number }> = [];
    for (const e of insightEntries) {
      for (const s of e.segments) {
        if (s.kind === 'MEETING' && s.endedAt) {
          meetingIntervals.push({ a: s.startedAt.getTime(), b: s.endedAt.getTime() });
        }
      }
    }
    const heatmapInput: HeatmapSample[] = samples.map((s) => {
      const t = s.bucketStart.getTime();
      const inMeeting = meetingIntervals.some((iv) => t >= iv.a && t < iv.b);
      return {
        bucketStartMs: t,
        keystrokes: s.keystrokes,
        clicks: s.clicks,
        scrollEvents: s.scrollEvents,
        mouseDistancePx: s.mouseDistancePx,
        isProtectedMeeting: inMeeting,
      };
    });
    // Align the heatmap strip to the framed (shift-bounded, activity-expanded)
    // window so it lines up column-for-column with the ribbon above it.
    const heatmap = buildHeatmap({
      dayStart: result.dayStart,
      dayEnd: result.dayEnd,
      samples: heatmapInput,
      bucketMs: DEFAULT_BUCKET_MS,
    });

    // M14: top-N apps for the day. Server has already scrubbed disallowed
    // active fields per the workspace policy at ingestion time — when the
    // policy is "captureApps off", every sample's activeApp is null and
    // buildAppUsage returns an empty top list, which the dashboard hides.
    const appUsageBase = buildAppUsage(
      samples.map((s) => ({
        activeApp: s.activeApp,
        activeAppBundle: s.activeAppBundle,
        keystrokes: s.keystrokes,
        clicks: s.clicks,
      })),
    );
    const storedIcons = await storedIconDataUrls(appUsageBase.topApps.map((a) => a.appBundle));
    const appUsage = {
      ...appUsageBase,
      topApps: appUsageBase.topApps.map((app) => ({
        ...app,
        iconUrl: resolveAppIcon(app.app, app.appBundle, storedIcons),
      })),
    };

    res.json({ ...result, activity: heatmap, appUsage });
  } catch (err) {
    next(err);
  }
});

export default insightsRouter;
