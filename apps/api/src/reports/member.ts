import {
  addDays,
  isValidTimeZone,
  isYmd,
  todayKey,
  type MemberReportApp,
  type MemberReportDay,
  type MemberReportScreenshot,
} from '@grind/types';
import {
  DEFAULT_LATE_GRACE_MINUTES,
  halfDayLateAfterMs,
  bucketByDay,
  containsInstant,
  emptyDayBucket,
  invalidationsByUser,
  shiftStatusFor,
  shiftWindowFor,
  type Interval,
  type TimelineInvalidation,
  type TimelinePiece,
  activityPercentOverTrackedMinutes,
  clipInterval,
} from '@grind/core';
import { appUsageIdentity, buildAppUsage } from '../insights/appUsage';
import { appIconUrl } from '../insights/appIcon';
import { buildDayInsight, localDayWindow, type DayEntryMeta } from '../insights/day';
import { buildHeatmap, DEFAULT_BUCKET_MS, type HeatmapSample } from '../insights/heatmap';
import type { AttendanceRuleMode, AttendanceRuleVerdict, DayStatus } from '@grind/types';
import { computedCodeWithRule, overrideCode, type DayOverride } from './monthPerformance';
import { dateRange } from '../insights/timesheets';
import type { RoleTitle } from '../scoring/presets';
import { scoreMinute } from '../scoring/score';

const MEMBER_REPORT_MAX_DAYS = 60;
const MEMBER_REPORT_DEFAULT_DAYS = 7;

export interface ReportRange {
  from: string;
  to: string;
  tz: string;
  days: string[];
  rangeStart: Date;
  rangeEnd: Date;
}

export interface ReportRangeError {
  status: number;
  error: string;
  extras?: Record<string, unknown>;
}

/**
 * One person's resolved timeline (from `apps/api/src/time`): one owner per
 * instant, open ends proven, invalidated minutes flagged. Include a day of
 * lookback before the range so work running into the first day reads as a
 * continuation.
 */
export type ReportTimelinePiece = TimelinePiece<DayEntryMeta>;

export interface ReportManualRequest {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  requestedStart: Date;
  requestedEnd: Date;
  reason: string;
  larkTaskGuid: string | null;
  decidedReason: string | null;
  attendees?: Array<{ userId: string }>;
}

export interface ReportActivitySample {
  timeEntryId: string | null;
  bucketStart: Date;
  keystrokes: number;
  clicks: number;
  scrollEvents: number;
  mouseDistancePx: number;
  activeApp: string | null;
  activeAppBundle: string | null;
  activeUrl?: string | null;
}

export interface ReportScreenshotRow {
  id: string;
  timeEntryId: string | null;
  displayId: string | null;
  capturedAt: Date;
  s3Key: string | null;
  thumbS3Key: string | null;
  fullUrl: string | null;
  thumbUrl: string | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  blurred: boolean;
}

export interface ReportShiftAssignment {
  shiftId: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  shiftNameSnapshot: string | null;
  scheduleSnapshot: unknown;
  bufferMinSnapshot: number | null;
}

export function resolveReportRange(query: Record<string, unknown>, workspaceTz: string): ReportRange | ReportRangeError {
  // Authenticated report routes are workspace-calendar views. Older clients
  // may still send their device timezone; it must never redefine business
  // dates or split one workspace day differently from other surfaces.
  const tz = workspaceTz;
  if (query.tz !== undefined && (typeof query.tz !== 'string' || !isValidTimeZone(query.tz))) {
    return { status: 400, error: 'invalid_tz' };
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    return { status: 400, error: 'invalid_tz' };
  }

  if (query.from !== undefined && !isYmd(query.from)) return { status: 400, error: 'invalid_date' };
  if (query.to !== undefined && !isYmd(query.to)) return { status: 400, error: 'invalid_date' };
  const to = isYmd(query.to) ? query.to : todayKey(tz);
  const from = isYmd(query.from) ? query.from : addDays(to, -(MEMBER_REPORT_DEFAULT_DAYS - 1));
  if (from > to) return { status: 400, error: 'invalid_range' };

  const days = dateRange(from, to);
  if (days.length > MEMBER_REPORT_MAX_DAYS) {
    return {
      status: 400,
      error: 'range_too_long',
      extras: { maxDays: MEMBER_REPORT_MAX_DAYS },
    };
  }

  const first = localDayWindow(from, tz);
  const last = localDayWindow(to, tz);
  if (!first || !last) return { status: 400, error: 'invalid_date_or_tz' };
  return { from, to, tz, days, rangeStart: first.start, rangeEnd: last.end };
}

export function resolveSingleReportDay(query: Record<string, unknown>, fallbackTz: string): ReportRange | ReportRangeError {
  const date = isYmd(query.date) ? query.date : null;
  if (!date) return { status: 400, error: 'invalid_date' };
  const range = resolveReportRange({ from: date, to: date }, fallbackTz);
  if ('error' in range) return range;
  return range;
}

/** Resolves an app's icon URL; defaults to the brand map. Routes inject one that
 *  prefers the real agent-extracted icon (a `data:` URL) per bundle. */
export type IconResolver = (app: string, bundle: string | null, domain?: string | null) => string | null;

export function buildMemberReportDays(input: {
  userId: string;
  range: ReportRange;
  now: Date;
  /** This person's resolved timeline (see {@link ReportTimelinePiece}). */
  timeline: readonly ReportTimelinePiece[];
  /** Reviewer invalidations, for the activity samples. */
  invalidations?: readonly TimelineInvalidation[];
  manualRequests: ReportManualRequest[];
  samples: ReportActivitySample[];
  screenshots: ReportScreenshotRow[];
  shiftAssignments: ReportShiftAssignment[];
  /** Company grace after the shift start (leave policy). Defaults to 30. */
  lateGraceMinutes?: number;
  /** First-half leave day: late after this minute of the day (leave policy). Defaults to 14:00. */
  halfDayLateAfterMinute?: number;
  activityRoleTitle?: RoleTitle | null;
  iconFor?: IconResolver;
  /** Working Calendar lookup, supplied by the route that loaded it. */
  dayStatusFor?: (userId: string, date: string) => DayStatus | null;
  /**
   * External punch record lookup, supplied by the route that loaded it. Absent
   * or returning null means the day has no punch, which stays null rather than
   * falling back to activity — the two are different measurements.
   */
  punchFor?: (userId: string, date: string) => { inMinute: number | null; outMinute: number | null } | null;
  /**
   * A manager's or admin's correction for a day, supplied by the route. The
   * report table shows the corrected code and marks it as corrected, so a
   * reader can tell a judgement from a measurement.
   */
  overrideFor?: (userId: string, date: string) => DayOverride | null;
  /** The attendance rules' verdict for a day, when the rules are on. */
  ruleFor?: (userId: string, date: string, status: DayStatus | null, trackedMinutes: number) => AttendanceRuleVerdict | null;
  /** How much of a day's cost a balance covered, undefined when it covered all. */
  fundedDaysFor?: (userId: string, date: string) => number | undefined;
  /**
   * The attendance rules' late count, when the rules are on. From `from` on, a
   * day reads Late exactly when the rules counted a late arrival — first
   * tracked activity past the shift start plus the policy's grace, by the one
   * core rule — so the Start column and the month sheet's Late number cannot
   * disagree.
   */
  lateFor?: { from: string; ordinalFor: (userId: string, date: string) => number | null };
  /**
   * How the attendance rules treat the person. A REMOTE or EXEMPT person never
   * reads Late, rules on or off — the rules never count them late.
   */
  attendanceModeFor?: (userId: string) => AttendanceRuleMode;
}): MemberReportDay[] {
  const iconFor = input.iconFor ?? appIconUrl;
  const pieces = input.timeline.filter((p) => p.userId === input.userId);
  const invalidated = invalidatedLookup(input.invalidations, input.userId);
  const buckets = bucketByDay(pieces, input.range.tz, input.range.days).get(input.userId);
  const grace = input.lateGraceMinutes ?? DEFAULT_LATE_GRACE_MINUTES;

  return input.range.days.map((date) => {
    const win = localDayWindow(date, input.range.tz);
    if (!win) {
      return emptyReportDay(date);
    }
    const dayStart = win.start.getTime();
    const dayEnd = win.end.getTime();
    const dayPieces = pieces.filter((p) => p.end > dayStart && p.start < dayEnd);
    const meetings = meetingIntervalsOf(dayPieces);
    const dayPending = input.manualRequests.filter((r) =>
      r.status === 'PENDING' && overlaps(r.requestedStart.getTime(), r.requestedEnd.getTime(), dayStart, dayEnd),
    );
    const dayRejected = input.manualRequests.filter((r) =>
      r.status === 'REJECTED' && overlaps(r.requestedStart.getTime(), r.requestedEnd.getTime(), dayStart, dayEnd),
    );
    const shift = shiftWindowFor(input.shiftAssignments, date, input.range.tz);
    const shiftWindow = shift ? { start: new Date(shift.startMs), end: new Date(shift.endMs) } : null;
    const insight = buildDayInsight({
      date,
      tz: input.range.tz,
      now: input.now,
      window: shiftWindow ?? win,
      calendarDay: win,
      shift: shift ? { name: shift.name, start: shift.start, end: shift.end } : null,
      shiftWindow,
      timeline: pieces,
      pending: dayPending.map((p) => ({
        id: p.id,
        requestedStart: p.requestedStart,
        requestedEnd: p.requestedEnd,
        reason: p.reason,
        larkTaskGuid: p.larkTaskGuid,
        attendeeIds: p.attendees?.map((a) => a.userId) ?? [],
      })),
      rejected: dayRejected.map((r) => ({
        id: r.id,
        requestedStart: r.requestedStart,
        requestedEnd: r.requestedEnd,
        reason: r.reason,
        decidedReason: r.decidedReason,
        larkTaskGuid: r.larkTaskGuid,
      })),
    });

    const bucket = buckets?.get(date) ?? emptyDayBucket();
    const gaps = insight.blocks.filter((b) => b.kind === 'GAP');
    const daySamples = samplesForWindow(input.samples, dayStart, dayEnd, invalidated);
    const appUsage = buildAppUsage(
      daySamples.map((s) => ({
        activeApp: s.activeApp,
        activeAppBundle: s.activeAppBundle,
        activeUrl: s.activeUrl,
        keystrokes: s.keystrokes,
        clicks: s.clicks,
      })),
      5,
    );
    const topApps = appUsage.topApps.map((a) => ({
      app: a.app,
      appBundle: a.appBundle,
      ...(a.domain ? { domain: a.domain } : {}),
      ...(a.sourceApp !== undefined ? { sourceApp: a.sourceApp } : {}),
      ...(a.sourceAppBundle !== undefined ? { sourceAppBundle: a.sourceAppBundle } : {}),
      iconUrl: iconFor(a.app, a.appBundle, a.domain),
      minutes: a.minutes,
      share: appUsage.totalMinutes > 0 ? a.minutes / appUsage.totalMinutes : 0,
    }));
    const approvals = countApprovalsForWindow(input.manualRequests, dayStart, dayEnd);
    const punch = input.punchFor?.(input.userId, date) ?? null;
    const dayStatus = input.dayStatusFor?.(input.userId, date) ?? null;
    const override = input.overrideFor?.(input.userId, date) ?? null;
    // Total tracked time, in minutes — the same measure the month performance
    // report bands on, so the two surfaces cannot call a day differently.
    const trackedMinutes = Math.round(bucket.counted / 60_000);
    const rule = input.ruleFor?.(input.userId, date, dayStatus, trackedMinutes) ?? null;
    const computedCode = computedCodeWithRule(
      dayStatus,
      trackedMinutes,
      rule,
      input.fundedDaysFor?.(input.userId, date),
    );
    const screenshotCount = input.screenshots.filter((s) =>
      s.capturedAt.getTime() >= dayStart && s.capturedAt.getTime() < dayEnd,
    ).length;

    return {
      date,
      workedMs: bucket.worked,
      meetingMs: bucket.meeting,
      manualMs: bucket.manual,
      invalidatedMs: bucket.invalidated,
      firstActivityMs: bucket.first,
      lastActivityMs: bucket.last,
      punchInMinute: punch?.inMinute ?? null,
      punchOutMinute: punch?.outMinute ?? null,
      // One late rule everywhere: first tracked activity (never manual) after
      // the shift assigned for this date plus the company grace — on a
      // first-half leave day, after the afternoon time — for a STANDARD
      // person only. With the attendance rules on, Late is what the rules
      // counted, so the Start column and the month sheet agree day for day.
      shiftStatus: shiftStatusFor({
        shiftStartMs: shift?.startMs ?? null,
        firstTrackedMs: bucket.firstTracked,
        countedMs: bucket.counted,
        graceMinutes: grace,
        halfDayLateAfterMs: halfDayLateAfterMs(date, input.range.tz, input.halfDayLateAfterMinute),
        status: dayStatus,
        mode: input.attendanceModeFor?.(input.userId),
        late: input.lateFor && date >= input.lateFor.from
          ? input.lateFor.ordinalFor(input.userId, date) !== null
          : undefined,
      }),
      gaps: {
        count: gaps.length,
        totalMs: gaps.reduce((sum, g) => sum + g.durationMs, 0),
      },
      approvals,
      activityPercent: activityPercent(
        daySamples,
        input.activityRoleTitle,
        meetings,
        Math.round(bucket.worked / 60_000),
      ),
      screenshots: { count: screenshotCount },
      topApps,
      dayStatus: dayStatus ?? null,
      attendanceCode: override ? overrideCode(override) : computedCode,
      attendanceOverride: override
        ? {
            code: override.code,
            // The ground moved since somebody made this call.
            stale: override.computedCode !== null && override.computedCode !== computedCode,
          }
        : null,
      computedAttendanceCode: computedCode,
      // A corrected day is the corrector's call; no rule speaks for it.
      attendanceRule: override ? null : rule,
    };
  });
}

export function buildMemberReportApps(input: {
  userId: string;
  range: ReportRange;
  samples: ReportActivitySample[];
  invalidations?: readonly TimelineInvalidation[];
  iconFor?: IconResolver;
}): { date: string; tz: string; totalMinutes: number; apps: MemberReportApp[] } {
  const iconFor = input.iconFor ?? appIconUrl;
  const win = localDayWindow(input.range.from, input.range.tz);
  const dayStart = win?.start.getTime() ?? 0;
  const dayEnd = win?.end.getTime() ?? 0;
  const samples = samplesForWindow(input.samples, dayStart, dayEnd, invalidatedLookup(input.invalidations, input.userId));
  const byApp = new Map<string, MemberReportApp & { scrolls: number; keystrokes: number; clicks: number }>();
  let totalMinutes = 0;
  for (const s of samples) {
    if (!s.activeApp) continue;
    const identity = appUsageIdentity(s);
    if (!identity) continue;
    totalMinutes += 1;
    const row = byApp.get(identity.key);
    if (row) {
      row.minutes += 1;
      row.keystrokes += s.keystrokes;
      row.clicks += s.clicks;
      row.scrolls += s.scrollEvents;
    } else {
      byApp.set(identity.key, {
        app: identity.app,
        appBundle: identity.appBundle,
        ...(identity.domain ? { domain: identity.domain } : {}),
        ...(identity.sourceApp !== undefined ? { sourceApp: identity.sourceApp } : {}),
        ...(identity.sourceAppBundle !== undefined ? { sourceAppBundle: identity.sourceAppBundle } : {}),
        iconUrl: iconFor(identity.app, identity.appBundle, identity.domain),
        minutes: 1,
        share: 0,
        keystrokes: s.keystrokes,
        clicks: s.clicks,
        scrolls: s.scrollEvents,
      });
    }
  }
  const apps = Array.from(byApp.values())
    .map((a) => ({ ...a, share: totalMinutes > 0 ? a.minutes / totalMinutes : 0 }))
    .sort((a, b) => {
      if (b.minutes !== a.minutes) return b.minutes - a.minutes;
      if (b.keystrokes !== a.keystrokes) return b.keystrokes - a.keystrokes;
      return a.app.localeCompare(b.app);
    });
  return { date: input.range.from, tz: input.range.tz, totalMinutes, apps };
}

export function buildMemberReportScreenshots(input: {
  userId: string;
  range: ReportRange;
  samples: ReportActivitySample[];
  screenshots: ReportScreenshotRow[];
  /** This person's resolved timeline; its meetings protect quiet minutes. */
  timeline?: readonly ReportTimelinePiece[];
  invalidations?: readonly TimelineInvalidation[];
  activityRoleTitle?: RoleTitle | null;
  toUrl: (row: ReportScreenshotRow, variant: 'full' | 'thumb') => string | null;
}): {
  date: string;
  tz: string;
  activityPercent: number | null;
  heatmap: ReturnType<typeof buildHeatmap>;
  screenshots: MemberReportScreenshot[];
} {
  const win = localDayWindow(input.range.from, input.range.tz);
  const dayStart = win?.start.getTime() ?? 0;
  const dayEnd = win?.end.getTime() ?? 0;
  const invalidated = invalidatedLookup(input.invalidations, input.userId);
  const samples = samplesForWindow(input.samples, dayStart, dayEnd, invalidated);
  const userPieces = (input.timeline ?? []).filter((p) => p.userId === input.userId);
  const meetingIntervals = meetingIntervalsOf(userPieces);
  const heatmap = buildHeatmap({
    dayStart,
    dayEnd,
    samples: heatmapSamples(samples, meetingIntervals),
    role: input.activityRoleTitle,
    bucketMs: DEFAULT_BUCKET_MS,
  });
  const screenshots = input.screenshots
    .filter((s) => s.capturedAt.getTime() >= dayStart && s.capturedAt.getTime() < dayEnd)
    .sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime())
    .map((s) => {
      const sample = sampleForScreenshot(samples, s.capturedAt.getTime());
      return {
        id: s.id,
        capturedAt: s.capturedAt.toISOString(),
        thumbUrl: input.toUrl(s, 'thumb'),
        fullUrl: input.toUrl(s, 'full'),
        width: s.width,
        height: s.height,
        bytes: s.bytes,
        blurred: s.blurred,
        invalidated: invalidated(s.capturedAt.getTime()),
        activityPercent: sample ? Math.round(100 * scoreSample(sample, input.activityRoleTitle, meetingIntervals)) : null,
        keystrokes: sample?.keystrokes ?? null,
        clicks: sample?.clicks ?? null,
        scrolls: sample?.scrollEvents ?? null,
        mouseDistancePx: sample?.mouseDistancePx ?? null,
        dominantApp: sample?.activeApp ?? null,
        dominantAppBundle: sample?.activeAppBundle ?? null,
        timeEntryId: s.timeEntryId,
      };
    });
  return {
    date: input.range.from,
    tz: input.range.tz,
    activityPercent: activityPercent(
      samples,
      input.activityRoleTitle,
      meetingIntervals,
      input.timeline ? trackedWorkMinutes(userPieces, dayStart, dayEnd) : null,
    ),
    heatmap,
    screenshots,
  };
}

function emptyReportDay(date: string): MemberReportDay {
  return {
    date,
    workedMs: 0,
    meetingMs: 0,
    manualMs: 0,
    invalidatedMs: 0,
    firstActivityMs: null,
    lastActivityMs: null,
    punchInMinute: null,
    punchOutMinute: null,
    shiftStatus: 'no_shift',
    gaps: { count: 0, totalMs: 0 },
    approvals: { approved: 0, pending: 0, rejected: 0 },
    activityPercent: null,
    screenshots: { count: 0 },
    topApps: [],
  };
}

function overlaps(startMs: number, endMs: number, winStartMs: number, winEndMs: number): boolean {
  return startMs < winEndMs && endMs > winStartMs;
}

function samplesForWindow(
  samples: ReportActivitySample[],
  startMs: number,
  endMs: number,
  invalidated: (t: number) => boolean,
): ReportActivitySample[] {
  return samples.filter((s) => {
    const t = s.bucketStart.getTime();
    if (t < startMs || t >= endMs) return false;
    return !invalidated(t);
  });
}

/** Is an instant inside one of this person's reviewer invalidations? */
function invalidatedLookup(
  invalidations: readonly TimelineInvalidation[] | undefined,
  userId: string,
): (t: number) => boolean {
  const merged: Interval[] = invalidationsByUser(invalidations).get(userId) ?? [];
  return (t) => containsInstant(merged, t);
}

function heatmapSamples(samples: ReportActivitySample[], meetingIntervals: Array<{ a: number; b: number }>): HeatmapSample[] {
  return samples.map((s) => ({
    bucketStartMs: s.bucketStart.getTime(),
    keystrokes: s.keystrokes,
    clicks: s.clicks,
    scrollEvents: s.scrollEvents,
    mouseDistancePx: s.mouseDistancePx,
    isProtectedMeeting: isInMeeting(meetingIntervals, s.bucketStart.getTime()),
  }));
}

/**
 * 0–100 over the minutes the person was TRACKED, through the one shared
 * definition (@grind/core). `trackedWorkMinutes` is agent work time from the
 * timer (meetings excluded — a meeting minute counts where it was sampled, at
 * full credit). Dividing by stored samples instead read a day of one busy
 * minute in ten as 100%: older agents stored nothing for a quiet minute.
 * Null when there is no activity data at all (e.g. input capture was off).
 */
function activityPercent(
  samples: ReportActivitySample[],
  role: RoleTitle | null | undefined,
  meetingIntervals: Array<{ a: number; b: number }>,
  trackedWorkMinutes: number | null,
): number | null {
  if (samples.length === 0) return null;
  let scoreSum = 0;
  let activeMinutes = 0;
  let meetingMinutes = 0;
  for (const s of samples) {
    const score = scoreSample(s, role, meetingIntervals);
    scoreSum += score;
    if (score > 0) activeMinutes += 1;
    if (isInMeeting(meetingIntervals, s.bucketStart.getTime())) meetingMinutes += 1;
  }
  return activityPercentOverTrackedMinutes(scoreSum, {
    sampledMinutes: samples.length,
    trackedMinutes: trackedWorkMinutes === null ? null : trackedWorkMinutes + meetingMinutes,
    activeMinutes,
  });
}

/**
 * Agent WORK time inside [startMs, endMs), in minutes — read from the resolved
 * timeline, so invalidated minutes and minutes another entry owns are excluded
 * (the same figure as the day's `workedMs`).
 */
function trackedWorkMinutes(pieces: readonly ReportTimelinePiece[], startMs: number, endMs: number): number {
  let ms = 0;
  for (const piece of pieces) {
    if (piece.kind !== 'WORK' || piece.invalidated) continue;
    const iv = clipInterval(piece, startMs, endMs);
    if (iv) ms += iv.end - iv.start;
  }
  return Math.round(ms / 60_000);
}

function scoreSample(
  sample: ReportActivitySample,
  role: RoleTitle | null | undefined,
  meetingIntervals: Array<{ a: number; b: number }>,
): number {
  const bucketStartMs = sample.bucketStart.getTime();
  return scoreMinute(
    {
      keystrokes: sample.keystrokes,
      clicks: sample.clicks,
      scrollEvents: sample.scrollEvents,
      mouseDistancePx: sample.mouseDistancePx,
    },
    { role, ctx: { isProtectedMeeting: isInMeeting(meetingIntervals, bucketStartMs) } },
  );
}

function meetingIntervalsOf(pieces: readonly ReportTimelinePiece[]): Array<{ a: number; b: number }> {
  return pieces.filter((p) => p.kind === 'MEETING').map((p) => ({ a: p.start, b: p.end }));
}

function isInMeeting(intervals: Array<{ a: number; b: number }>, epochMs: number): boolean {
  return intervals.some((iv) => epochMs >= iv.a && epochMs < iv.b);
}

function countApprovalsForWindow(
  requests: ReportManualRequest[],
  startMs: number,
  endMs: number,
): MemberReportDay['approvals'] {
  const out = { approved: 0, pending: 0, rejected: 0 };
  for (const r of requests) {
    if (r.status === 'CANCELLED') continue;
    if (!overlaps(r.requestedStart.getTime(), r.requestedEnd.getTime(), startMs, endMs)) continue;
    if (r.status === 'APPROVED') out.approved += 1;
    else if (r.status === 'PENDING') out.pending += 1;
    else if (r.status === 'REJECTED') out.rejected += 1;
  }
  return out;
}

function sampleForScreenshot(samples: ReportActivitySample[], capturedAtMs: number): ReportActivitySample | null {
  if (samples.length === 0) return null;
  let best: ReportActivitySample | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const s of samples) {
    const t = s.bucketStart.getTime();
    const delta = Math.abs(capturedAtMs - t);
    if (delta < bestDelta) {
      best = s;
      bestDelta = delta;
    }
  }
  return bestDelta <= 2 * 60_000 ? best : null;
}
