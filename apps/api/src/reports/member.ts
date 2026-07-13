import {
  WEEKDAYS,
  ShiftScheduleSchema,
  type MemberReportApp,
  type MemberReportDay,
  type MemberReportScreenshot,
  type ShiftSchedule,
  type ShiftStatus,
} from '@grind/types';
import { appUsageIdentity, buildAppUsage } from '../insights/appUsage';
import { appIconUrl } from '../insights/appIcon';
import { buildDayInsight, localDayWindow, shiftDayWindow } from '../insights/day';
import { buildHeatmap, DEFAULT_BUCKET_MS, type HeatmapSample } from '../insights/heatmap';
import {
  groupInvalidationsByUser,
  isInvalidatedAt,
  type InvalidationsByUser,
  type TimeInvalidationInput,
} from '../insights/invalidations';
import { latestSampleByEntry, latestScreenshotByEntry, resolveEffectiveSegmentEnd } from '../insights/openSegmentEvidence';
import { buildTimesheetMatrix, dateRange, type TimesheetSegmentInput } from '../insights/timesheets';
import type { RoleTitle } from '../scoring/presets';
import { scoreMinute } from '../scoring/score';

export const MEMBER_REPORT_MAX_DAYS = 60;
export const MEMBER_REPORT_DEFAULT_DAYS = 7;

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

export interface ReportTimeEntry {
  id: string;
  userId: string;
  source: 'AUTO' | 'MANUAL';
  larkTaskGuid: string | null;
  notes: string | null;
  trackingProtocolVersion?: number | null;
  lastProvenAt?: Date | null;
  leaseExpiresAt?: Date | null;
  segments: Array<{
    kind: 'WORK' | 'MEETING' | 'IDLE_TRIMMED';
    startedAt: Date;
    endedAt: Date | null;
  }>;
  attendees: Array<{ userId: string }>;
}

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

export function isYmd(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function todayKeyForTz(tz: string, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function addDaysKey(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

export function resolveReportRange(query: Record<string, unknown>): ReportRange | ReportRangeError {
  const tz = typeof query.tz === 'string' && query.tz.length > 0 ? query.tz : 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    return { status: 400, error: 'invalid_tz' };
  }

  if (query.from !== undefined && !isYmd(query.from)) return { status: 400, error: 'invalid_date' };
  if (query.to !== undefined && !isYmd(query.to)) return { status: 400, error: 'invalid_date' };
  const to = isYmd(query.to) ? query.to : todayKeyForTz(tz);
  const from = isYmd(query.from) ? query.from : addDaysKey(to, -(MEMBER_REPORT_DEFAULT_DAYS - 1));
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

export function resolveSingleReportDay(query: Record<string, unknown>): ReportRange | ReportRangeError {
  const date = isYmd(query.date) ? query.date : null;
  if (!date) return { status: 400, error: 'invalid_date' };
  const range = resolveReportRange({ from: date, to: date, tz: query.tz });
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
  entries: ReportTimeEntry[];
  manualRequests: ReportManualRequest[];
  samples: ReportActivitySample[];
  screenshots: ReportScreenshotRow[];
  shiftAssignments: ReportShiftAssignment[];
  invalidations?: TimeInvalidationInput[];
  activityRoleTitle?: RoleTitle | null;
  iconFor?: IconResolver;
}): MemberReportDay[] {
  const iconFor = input.iconFor ?? appIconUrl;
  const entries = capOpenEntries(input.entries, input.samples, input.screenshots, input.now);
  const invalidationsByUser = groupInvalidationsByUser(input.invalidations);
  const segments: TimesheetSegmentInput[] = [];
  const nowMs = input.now.getTime();
  for (const e of entries) {
    for (const s of e.segments) {
      segments.push({
        userId: e.userId,
        source: e.source,
        segmentKind: s.kind,
        startedAt: s.startedAt.getTime(),
        endedAt: (s.endedAt ?? input.now).getTime(),
      });
    }
  }

  const matrix = buildTimesheetMatrix({
    from: input.range.from,
    to: input.range.to,
    tz: input.range.tz,
    segments,
    invalidations: input.invalidations,
  });
  const cells = matrix?.cells[input.userId] ?? {};

  return input.range.days.map((date) => {
    const win = localDayWindow(date, input.range.tz);
    if (!win) {
      return emptyReportDay(date);
    }
    const dayStart = win.start.getTime();
    const dayEnd = win.end.getTime();
    const dayEntries = entries.filter((e) =>
      e.segments.some((s) => overlaps(s.startedAt.getTime(), (s.endedAt ?? input.now).getTime(), dayStart, dayEnd)),
    );
    const meetingIntervals = meetingIntervalsForEntries(dayEntries, input.now);
    const dayPending = input.manualRequests.filter((r) =>
      r.status === 'PENDING' && overlaps(r.requestedStart.getTime(), r.requestedEnd.getTime(), dayStart, dayEnd),
    );
    const dayRejected = input.manualRequests.filter((r) =>
      r.status === 'REJECTED' && overlaps(r.requestedStart.getTime(), r.requestedEnd.getTime(), dayStart, dayEnd),
    );
    const shift = resolveShiftForDay(date, input.range.tz, win, input.shiftAssignments);
    const insight = buildDayInsight({
      date,
      tz: input.range.tz,
      now: input.now,
      window: shift.window ?? win,
      calendarDay: win,
      shift: shift.label,
      entries: dayEntries.map((e) => ({
        id: e.id,
        source: e.source,
        larkTaskGuid: e.larkTaskGuid,
        notes: e.notes,
        attendeeIds: e.attendees.map((a) => a.userId),
        segments: e.segments.map((s) => ({
          kind: s.kind,
          startedAt: s.startedAt,
          endedAt: s.endedAt,
        })),
      })),
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

    const cell = cells[date] ?? {
      workedMs: 0,
      meetingMs: 0,
      manualMs: 0,
      invalidatedMs: 0,
      totalMs: 0,
      firstActivityMs: null,
      lastActivityMs: null,
      activitySampleCount: 0,
    };
    const gaps = insight.blocks.filter((b) => b.kind === 'GAP');
    const daySamples = samplesForWindow(input.samples, dayStart, dayEnd, invalidationsByUser, input.userId);
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
    const screenshotCount = input.screenshots.filter((s) =>
      s.capturedAt.getTime() >= dayStart && s.capturedAt.getTime() < dayEnd,
    ).length;

    return {
      date,
      workedMs: cell.workedMs,
      meetingMs: cell.meetingMs,
      manualMs: cell.manualMs,
      invalidatedMs: cell.invalidatedMs,
      firstActivityMs: cell.firstActivityMs,
      lastActivityMs: cell.lastActivityMs,
      shiftStatus: computeShiftStatus({
        shift,
        firstActivityMs: cell.firstActivityMs,
        nowMs,
      }),
      gaps: {
        count: gaps.length,
        totalMs: gaps.reduce((sum, g) => sum + g.durationMs, 0),
      },
      approvals,
      activityPercent: activityPercent(daySamples, input.activityRoleTitle, meetingIntervals),
      screenshots: { count: screenshotCount },
      topApps,
    };
  });
}

function capOpenEntries(
  entries: ReportTimeEntry[],
  samples: ReportActivitySample[],
  screenshots: ReportScreenshotRow[],
  now: Date,
): ReportTimeEntry[] {
  const latest = latestSampleByEntry(samples);
  const latestScreenshot = latestScreenshotByEntry(screenshots);
  return entries.map((entry) => ({
    ...entry,
    segments: entry.segments.map((segment) => ({
      ...segment,
      endedAt: resolveEffectiveSegmentEnd({
        startedAt: segment.startedAt,
        endedAt: segment.endedAt,
        now,
        latestSampleAt: latest.get(entry.id),
        latestScreenshotAt: latestScreenshot.get(entry.id),
        lifecycle: entry,
      }),
    })),
  }));
}

export function buildMemberReportApps(input: {
  userId: string;
  range: ReportRange;
  samples: ReportActivitySample[];
  invalidations?: TimeInvalidationInput[];
  iconFor?: IconResolver;
}): { date: string; tz: string; totalMinutes: number; apps: MemberReportApp[] } {
  const iconFor = input.iconFor ?? appIconUrl;
  const win = localDayWindow(input.range.from, input.range.tz);
  const dayStart = win?.start.getTime() ?? 0;
  const dayEnd = win?.end.getTime() ?? 0;
  const invalidationsByUser = groupInvalidationsByUser(input.invalidations);
  const samples = samplesForWindow(input.samples, dayStart, dayEnd, invalidationsByUser, input.userId);
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
  entries?: ReportTimeEntry[];
  invalidations?: TimeInvalidationInput[];
  activityRoleTitle?: RoleTitle | null;
  now?: Date;
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
  const invalidationsByUser = groupInvalidationsByUser(input.invalidations);
  const samples = samplesForWindow(input.samples, dayStart, dayEnd, invalidationsByUser, input.userId);
  const reportNow = input.now ?? new Date();
  const meetingIntervals = meetingIntervalsForEntries(
    capOpenEntries(input.entries ?? [], input.samples, input.screenshots, reportNow),
    reportNow,
  );
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
      const invalidated = isInvalidatedAt(invalidationsByUser, input.userId, s.capturedAt.getTime());
      return {
        id: s.id,
        capturedAt: s.capturedAt.toISOString(),
        thumbUrl: input.toUrl(s, 'thumb'),
        fullUrl: input.toUrl(s, 'full'),
        width: s.width,
        height: s.height,
        bytes: s.bytes,
        blurred: s.blurred,
        invalidated,
        activityPercent: sample ? Math.round(100 * scoreSample(sample, input.activityRoleTitle, meetingIntervals)) : null,
        dominantApp: sample?.activeApp ?? null,
        dominantAppBundle: sample?.activeAppBundle ?? null,
        timeEntryId: s.timeEntryId,
      };
    });
  return {
    date: input.range.from,
    tz: input.range.tz,
    activityPercent: activityPercent(samples, input.activityRoleTitle, meetingIntervals),
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
  invalidationsByUser?: InvalidationsByUser,
  userId?: string,
): ReportActivitySample[] {
  return samples.filter((s) => {
    const t = s.bucketStart.getTime();
    if (t < startMs || t >= endMs) return false;
    return !(invalidationsByUser && userId && isInvalidatedAt(invalidationsByUser, userId, t));
  });
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

function activityPercent(
  samples: ReportActivitySample[],
  role: RoleTitle | null | undefined,
  meetingIntervals: Array<{ a: number; b: number }>,
): number | null {
  if (samples.length === 0) return null;
  let sum = 0;
  for (const s of samples) {
    sum += scoreSample(s, role, meetingIntervals);
  }
  return Math.round((100 * sum) / samples.length);
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

function meetingIntervalsForEntries(entries: ReportTimeEntry[], now: Date): Array<{ a: number; b: number }> {
  const out: Array<{ a: number; b: number }> = [];
  for (const entry of entries) {
    for (const segment of entry.segments) {
      if (segment.kind !== 'MEETING') continue;
      const a = segment.startedAt.getTime();
      const b = (segment.endedAt ?? now).getTime();
      if (b > a) out.push({ a, b });
    }
  }
  return out;
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

interface ResolvedShiftForDay {
  assignment: ReportShiftAssignment | null;
  schedule: ShiftSchedule | null;
  bufferMin: number;
  window: { start: Date; end: Date } | null;
  label: { name: string; start: string; end: string } | null;
}

function resolveShiftForDay(
  date: string,
  tz: string,
  win: { start: Date; end: Date },
  assignments: ReportShiftAssignment[],
): ResolvedShiftForDay {
  const startMs = win.start.getTime();
  const endMs = win.end.getTime();
  const assignment = assignments
    .filter((a) =>
      a.effectiveFrom.getTime() < endMs &&
      (a.effectiveTo === null || a.effectiveTo.getTime() > startMs),
    )
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0] ?? null;
  if (!assignment?.shiftId) {
    return { assignment, schedule: null, bufferMin: 0, window: null, label: null };
  }
  const parsed = ShiftScheduleSchema.safeParse(assignment.scheduleSnapshot);
  if (!parsed.success) {
    return { assignment, schedule: null, bufferMin: assignment.bufferMinSnapshot ?? 0, window: null, label: null };
  }
  const window = shiftDayWindow(date, tz, parsed.data);
  const weekday = weekdayForDate(date);
  const day = parsed.data[weekday];
  const label =
    window && day
      ? {
          name: assignment.shiftNameSnapshot ?? 'Shift',
          start: day.start,
          end: day.end,
        }
      : null;
  return {
    assignment,
    schedule: parsed.data,
    bufferMin: assignment.bufferMinSnapshot ?? 0,
    window,
    label,
  };
}

function computeShiftStatus(input: {
  shift: ResolvedShiftForDay;
  firstActivityMs: number | null;
  nowMs: number;
}): ShiftStatus {
  if (!input.shift.assignment || !input.shift.schedule || !input.shift.window) return 'no_shift';
  if (input.firstActivityMs === null) return 'no_activity';
  const startMs = input.shift.window.start.getTime();
  if (input.firstActivityMs < startMs) return 'early';
  const bufferMs = Math.max(0, input.shift.bufferMin) * 60_000;
  return input.firstActivityMs <= startMs + bufferMs ? 'on_time' : 'late';
}

function weekdayForDate(date: string): (typeof WEEKDAYS)[number] {
  const [yy, mm, dd] = date.split('-').map((n) => parseInt(n, 10));
  return WEEKDAYS[new Date(Date.UTC(yy!, mm! - 1, dd!)).getUTCDay()]!;
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
