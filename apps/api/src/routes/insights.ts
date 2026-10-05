import { Router } from 'express';
import { prisma } from '@grind/db';
import { requireAccessToken } from '../middleware/auth';
import { attachScope } from '../middleware/scope';
import { scoreDay } from '../scoring/score';
import { assessWindow, type RiskSample } from '../anticheat/risk';
import type { RoleTitle } from '../scoring/presets';
import { buildDayInsight, localDayWindow } from '../insights/day';
import { shiftTimesFromSchedule, shiftWindowFor } from '@grind/core';
import { dateKeyInTimeZone, isValidTimeZone, zonedDateTimeParts, type ShiftSchedule } from '@grind/types';
import { buildHeatmap, DEFAULT_BUCKET_MS, type HeatmapSample } from '../insights/heatmap';
import { buildAppUsage } from '../insights/appUsage';
import { resolveAppIcon, storedIconDataUrls } from '../insights/appIcon';
import {
  invalidatedAt,
  loadShiftAssignments,
  loadTimeline,
  meetingIntervals,
  piecesForUser,
  withEntryMeta,
} from '../time';

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

/** Resolve one business-calendar day, never the API host's local calendar. */
function dayWindow(day: string | undefined, timezone: string): { start: Date; end: Date } | null {
  return localDayWindow(day ?? dateKeyInTimeZone(new Date(), timezone), timezone);
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
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    if (req.query.tz !== undefined && (typeof req.query.tz !== 'string' || !isValidTimeZone(req.query.tz))) {
      return res.status(400).json({ error: 'invalid_tz' });
    }
    const timezone = req.scope.workspaceTimezone;
    const requestedDay = typeof req.query.day === 'string'
      ? req.query.day
      : dateKeyInTimeZone(new Date(), timezone);
    const win = dayWindow(requestedDay, timezone);
    if (!win) return res.status(400).json({ error: 'invalid_day' });

    const [user, samplesRaw, timeline] = await Promise.all([
      prisma.user.findUnique({
        where: { id: req.user.sub },
        select: { activityRoleTitle: true },
      }),
      prisma.activitySample.findMany({
        where: { userId: req.user.sub, bucketStart: { gte: win.start, lt: win.end } },
        orderBy: { bucketStart: 'asc' },
        select: {
          timeEntryId: true,
          bucketStart: true,
          keystrokes: true,
          clicks: true,
          scrollEvents: true,
          mouseDistancePx: true,
          ikiCv: true,
          moveSpeedCv: true,
          pathStraightness: true,
        },
      }),
      loadTimeline({ userIds: [req.user.sub], from: requestedDay, to: requestedDay, tz: timezone }),
    ]);

    const role = (user?.activityRoleTitle ?? 'OTHER') as RoleTitle;
    const invalidated = invalidatedAt(timeline.invalidations);
    const meetings = meetingIntervals(timeline.pieces);
    const samples = samplesRaw
      .filter((s) => !invalidated(req.user!.sub, s.bucketStart.getTime()))
      .map((s) => ({
        ...s,
        isProtectedMeeting: isInMeeting(meetings, s.bucketStart.getTime()),
      }));
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
      byHour[zonedDateTimeParts(s.bucketStart, timezone).hour]! += s.keystrokes + s.clicks;
    }

    res.json({
      day: requestedDay,
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
 * GET /v1/insights/day?date=YYYY-MM-DD&tz=IANA&gapScope=shift|calendar-day
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
    if (!req.scope) return res.status(500).json({ error: 'scope_unresolved' });
    if (req.query.tz !== undefined && (typeof req.query.tz !== 'string' || !isValidTimeZone(req.query.tz))) {
      return res.status(400).json({ error: 'invalid_tz' });
    }
    if (
      req.query.gapScope !== undefined &&
      req.query.gapScope !== 'shift' &&
      req.query.gapScope !== 'calendar-day'
    ) {
      return res.status(400).json({ error: 'invalid_gap_scope' });
    }
    const gapScope = req.query.gapScope === 'calendar-day' ? 'calendar-day' : 'shift';
    const tz = req.scope.workspaceTimezone;
    const date = typeof req.query.date === 'string' ? req.query.date : dateKeyInTimeZone(new Date(), tz);
    const win = localDayWindow(date, tz);
    if (!win) return res.status(400).json({ error: 'invalid_date_or_tz' });

    const targetUser = resolveTargetUserId(req, req.query.userId);
    if (!targetUser.ok) return res.status(targetUser.status).json({ error: targetUser.error });
    const userId = targetUser.userId;

    const now = new Date();

    // Resolve the shift assigned FOR THIS DATE (assignment history), separately
    // from the requested gap scope. Most consumers retain shift-scoped gap
    // metrics. Edit Time explicitly asks for a calendar-day partition so its
    // outside-shift empty intervals use the same gap composer without
    // redefining Home/Reports attendance semantics.
    const [userRow, assignments, timeline] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          activityRoleTitle: true,
          shift: { select: { name: true, schedule: true } },
        },
      }),
      loadShiftAssignments([userId], win.start, win.end),
      loadTimeline({ userIds: [userId], from: date, to: date, tz, now }),
    ]);
    const userAssignments = assignments.get(userId) ?? [];
    const assigned = shiftWindowFor(userAssignments, date, tz);
    // Accounts that predate assignment history only have their current shift.
    const legacy = userAssignments.length === 0 && userRow?.shift
      ? shiftTimesFromSchedule(userRow.shift.schedule as ShiftSchedule, date, tz)
      : null;
    const shiftTimes = assigned ?? legacy;
    const shiftWin = shiftTimes ? { start: new Date(shiftTimes.startMs), end: new Date(shiftTimes.endMs) } : null;
    const frame = gapScope === 'calendar-day' ? win : shiftWin ?? win;
    const shiftLabel: { name: string; start: string; end: string } | null = assigned
      ? { name: assigned.name, start: assigned.start, end: assigned.end }
      : legacy && userRow?.shift
        ? { name: userRow.shift.name, start: legacy.start, end: legacy.end }
        : null;

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

    const samplesRaw = await prisma.activitySample.findMany({
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
        activeUrl: true,
      },
      orderBy: { bucketStart: 'asc' },
    });
    const invalidated = invalidatedAt(timeline.invalidations);
    const samples = samplesRaw.filter((s) => !invalidated(userId, s.bucketStart.getTime()));
    const userPieces = piecesForUser(timeline.pieces, userId);

    const result = buildDayInsight({
      date,
      tz,
      now,
      window: frame,
      calendarDay: win,
      shift: shiftLabel,
      shiftWindow: shiftWin,
      timeline: withEntryMeta(userPieces),
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
    // dead air differently. A minute inside a MEETING piece of the resolved
    // timeline is scored as a protected meeting.
    const meetings = meetingIntervals(userPieces);
    const heatmapInput: HeatmapSample[] = samples.map((s) => {
      const t = s.bucketStart.getTime();
      const inMeeting = isInMeeting(meetings, t);
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
      role: (userRow?.activityRoleTitle ?? 'OTHER') as RoleTitle,
      bucketMs: DEFAULT_BUCKET_MS,
    });
    const fullDayActivity = buildHeatmap({
      dayStart: result.calendarDayStart,
      dayEnd: result.calendarDayEnd,
      samples: heatmapInput,
      role: (userRow?.activityRoleTitle ?? 'OTHER') as RoleTitle,
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
        activeUrl: s.activeUrl,
        keystrokes: s.keystrokes,
        clicks: s.clicks,
      })),
    );
    const storedIcons = await storedIconDataUrls(appUsageBase.topApps.map((a) => a.appBundle));
    const appUsage = {
      ...appUsageBase,
      topApps: appUsageBase.topApps.map((app) => ({
        ...app,
        iconUrl: resolveAppIcon(app.app, app.appBundle, storedIcons, app.domain),
      })),
    };

    res.json({ ...result, activity: heatmap, fullDayActivity, appUsage });
  } catch (err) {
    next(err);
  }
});

export default insightsRouter;

function isInMeeting(intervals: Array<{ a: number; b: number }>, epochMs: number): boolean {
  return intervals.some((iv) => epochMs >= iv.a && epochMs < iv.b);
}
