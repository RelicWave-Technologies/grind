import { prisma, type Prisma } from '@grind/db';
import {
  bucketByDay,
  containsInstant,
  emptyDayBucket,
  invalidationsByUser,
  resolveTimeline,
  shiftStatusFor,
  shiftWindowFor,
  isLate,
  halfDayLateAfterMs,
  type DayBucket,
  type EntryLiveEvidenceMap,
  type ShiftDay,
  type TimelineInvalidation,
  type TimelinePiece,
} from '@grind/core';
import {
  dateKeysBetween,
  localDayWindowInTimeZone,
  type DayStatus,
  type ShiftStatus,
} from '@grind/types';
import { loadEntryLiveEvidence } from '../insights/liveEntryEvidence';
import { timesheetCalendarInputs } from '../leave';
import { loadOrCreateLeavePolicy } from '../leave/repository';

/**
 * The one way the API reads tracked time.
 *
 * Entries, the live evidence for their open segments, and reviewer
 * invalidations are loaded together and resolved by `@grind/core`'s
 * `resolveTimeline`. Every screen that shows time goes through here, so a
 * minute counts — or does not — the same way on Edit Time, Home, the reports,
 * the overview, Lark and the month report.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const TIMELINE_ENTRY_SELECT = {
  id: true,
  userId: true,
  source: true,
  larkTaskGuid: true,
  notes: true,
  startedAt: true,
  endedAt: true,
  trackingProtocolVersion: true,
  lastProvenAt: true,
  leaseExpiresAt: true,
  segments: {
    select: { id: true, kind: true, startedAt: true, endedAt: true },
    orderBy: { startedAt: 'asc' },
  },
  attendees: { select: { userId: true } },
  manualTimeRequest: { select: { id: true } },
} satisfies Prisma.TimeEntrySelect;

type TimelineRow = Prisma.TimeEntryGetPayload<{ select: typeof TIMELINE_ENTRY_SELECT }>;
export type TimelineRowPiece = TimelinePiece<TimelineRow>;

export interface LoadedTimeline {
  /** The window asked for. `pieces` also covers `lookbackMs` before it. */
  start: Date;
  end: Date;
  now: Date;
  entries: TimelineRow[];
  evidence: EntryLiveEvidenceMap;
  invalidations: TimelineInvalidation[];
  /** One owner per instant per user; not clipped to the window. */
  pieces: TimelineRowPiece[];
}

export async function loadInvalidations(
  userIds: readonly string[],
  start: Date,
  end: Date,
  db: Pick<Prisma.TransactionClient, 'timeInvalidation'> = prisma,
): Promise<TimelineInvalidation[]> {
  if (userIds.length === 0) return [];
  const rows = await db.timeInvalidation.findMany({
    where: { userId: { in: [...userIds] }, windowStart: { lt: end }, windowEnd: { gt: start } },
    select: { userId: true, windowStart: true, windowEnd: true },
    orderBy: [{ userId: 'asc' }, { windowStart: 'asc' }],
  });
  return rows.map((r) => ({ userId: r.userId, start: r.windowStart.getTime(), end: r.windowEnd.getTime() }));
}

/**
 * Resolved time for `userIds` over an instant window.
 *
 * `lookbackMs` (default one day) widens the read backwards so a stretch that
 * started before the window is seen as a continuation rather than a start.
 */
export async function loadTimelineWindow(input: {
  userIds: readonly string[];
  start: Date;
  end: Date;
  now?: Date;
  lookbackMs?: number;
  /** Narrow to some entries (e.g. one Lark task's). Owner resolution still sees all. */
  where?: Prisma.TimeEntryWhereInput;
}): Promise<LoadedTimeline> {
  const now = input.now ?? new Date();
  const readStart = new Date(input.start.getTime() - (input.lookbackMs ?? DAY_MS));
  const userIds = [...new Set(input.userIds)];
  if (userIds.length === 0 || input.end <= readStart) {
    return { start: input.start, end: input.end, now, entries: [], evidence: new Map(), invalidations: [], pieces: [] };
  }
  const [entries, invalidations] = await Promise.all([
    prisma.timeEntry.findMany({
      where: {
        userId: { in: userIds },
        startedAt: { lt: input.end },
        OR: [{ endedAt: null }, { endedAt: { gt: readStart } }],
        ...(input.where ?? {}),
      },
      select: TIMELINE_ENTRY_SELECT,
      orderBy: [{ userId: 'asc' }, { startedAt: 'asc' }, { id: 'asc' }],
    }),
    loadInvalidations(userIds, readStart, input.end),
  ]);
  const evidence = await loadEntryLiveEvidence(entries, now);
  const pieces = resolveTimeline(entries, { now, evidence, invalidations });
  return { start: input.start, end: input.end, now, entries, evidence, invalidations, pieces };
}

export interface LoadedTimelineDays extends LoadedTimeline {
  tz: string;
  from: string;
  to: string;
  days: string[];
  /** userId → date → day bucket (only users with any time appear). */
  buckets: Map<string, Map<string, DayBucket>>;
  bucket(userId: string, date: string): DayBucket;
}

/** Resolved time for `userIds` over the workspace dates `[from, to]`. */
export async function loadTimeline(input: {
  userIds: readonly string[];
  from: string;
  to: string;
  tz: string;
  now?: Date;
}): Promise<LoadedTimelineDays> {
  const first = localDayWindowInTimeZone(input.from, input.tz);
  const last = localDayWindowInTimeZone(input.to, input.tz);
  if (!first || !last) throw new Error('invalid_date_or_tz');
  const loaded = await loadTimelineWindow({
    userIds: input.userIds,
    start: first.start,
    end: last.end,
    now: input.now,
  });
  return withDays(loaded, input.tz, input.from, input.to);
}

/** Attribute an already-loaded timeline to workspace dates. */
function withDays(loaded: LoadedTimeline, tz: string, from: string, to: string): LoadedTimelineDays {
  const days = dateKeysBetween(from, to);
  const buckets = bucketByDay(loaded.pieces, tz, days);
  return {
    ...loaded,
    tz,
    from,
    to,
    days,
    buckets,
    bucket: (userId, date) => buckets.get(userId)?.get(date) ?? emptyDayBucket(),
  };
}

/** Pieces for one user, in order. */
export function piecesForUser<P extends { userId: string }>(pieces: readonly P[], userId: string): P[] {
  return pieces.filter((p) => p.userId === userId);
}

// ---------------------------------------------------------------------------
// Shifts
// ---------------------------------------------------------------------------

export interface ShiftAssignmentRow {
  userId: string;
  shiftId: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  shiftNameSnapshot: string | null;
  scheduleSnapshot: unknown;
  bufferMinSnapshot: number | null;
}

/** Assignment history overlapping `[start, end)`, grouped by user. */
export async function loadShiftAssignments(
  userIds: readonly string[],
  start: Date,
  end: Date,
): Promise<Map<string, ShiftAssignmentRow[]>> {
  const out = new Map<string, ShiftAssignmentRow[]>();
  if (userIds.length === 0) return out;
  const rows = await prisma.shiftAssignment.findMany({
    where: {
      userId: { in: [...userIds] },
      effectiveFrom: { lt: end },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: start } }],
    },
    select: {
      userId: true,
      shiftId: true,
      effectiveFrom: true,
      effectiveTo: true,
      shiftNameSnapshot: true,
      scheduleSnapshot: true,
      bufferMinSnapshot: true,
    },
    orderBy: [{ userId: 'asc' }, { effectiveFrom: 'asc' }],
  });
  for (const row of rows) {
    const list = out.get(row.userId) ?? [];
    list.push(row);
    out.set(row.userId, list);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Day facts
// ---------------------------------------------------------------------------

interface DayFacts {
  bucket: DayBucket;
  status: DayStatus | null;
  shift: ShiftDay<ShiftAssignmentRow> | null;
  /** Counted minutes (work + meetings + manual), rounded. */
  trackedMinutes: number;
  late: boolean;
  shiftStatus: ShiftStatus;
}

export interface DayFactsSource {
  timeline: LoadedTimelineDays;
  graceMinutes: number;
  calendar: Awaited<ReturnType<typeof timesheetCalendarInputs>>;
  shiftFor(userId: string, date: string): ShiftDay<ShiftAssignmentRow> | null;
  factsFor(userId: string, date: string): DayFacts;
}

/** The pure part of day facts — everything handed in. */
function dayFactsOf(input: {
  bucket: DayBucket;
  status: DayStatus | null;
  shift: ShiftDay<ShiftAssignmentRow> | null;
  graceMinutes: number;
  /** First-half leave day: late after this instant, no grace. */
  halfDayLateAfterMs: number | null;
}): DayFacts {
  const shiftStartMs = input.shift?.startMs ?? null;
  return {
    bucket: input.bucket,
    status: input.status,
    shift: input.shift,
    trackedMinutes: Math.round(input.bucket.counted / 60_000),
    late: isLate({
      firstTrackedMs: input.bucket.firstTracked,
      shiftStartMs,
      graceMinutes: input.graceMinutes,
      halfDayLateAfterMs: input.halfDayLateAfterMs,
      status: input.status,
    }),
    shiftStatus: shiftStatusFor({
      shiftStartMs,
      firstTrackedMs: input.bucket.firstTracked,
      countedMs: input.bucket.counted,
      graceMinutes: input.graceMinutes,
      halfDayLateAfterMs: input.halfDayLateAfterMs,
      status: input.status,
    }),
  };
}

/**
 * Everything a day is judged on, for `userIds` over `[from, to]`: the counted
 * time, the Working Calendar status, the shift assigned for that date, the
 * company grace and the first-half leave afternoon time — combined by the one
 * late/full/half definition in core.
 */
export async function loadDayFacts(input: {
  workspaceId: string;
  userIds: readonly string[];
  from: string;
  to: string;
  tz: string;
  now?: Date;
  /** Reuse a timeline the caller already loaded for the same range. */
  timeline?: LoadedTimelineDays;
  calendar?: Awaited<ReturnType<typeof timesheetCalendarInputs>>;
}): Promise<DayFactsSource> {
  const userIds = [...new Set(input.userIds)];
  const first = localDayWindowInTimeZone(input.from, input.tz);
  const last = localDayWindowInTimeZone(input.to, input.tz);
  if (!first || !last) throw new Error('invalid_date_or_tz');
  const [timeline, calendar, assignments, policy] = await Promise.all([
    input.timeline ?? loadTimeline({ userIds, from: input.from, to: input.to, tz: input.tz, now: input.now }),
    input.calendar ?? timesheetCalendarInputs({
      workspaceId: input.workspaceId,
      tz: input.tz,
      userIds,
      from: input.from,
      to: input.to,
    }),
    loadShiftAssignments(userIds, first.start, last.end),
    loadOrCreateLeavePolicy(input.workspaceId),
  ]);
  const graceMinutes = policy.lateGraceMinutes;
  const shiftCache = new Map<string, ShiftDay<ShiftAssignmentRow> | null>();
  const shiftFor = (userId: string, date: string) => {
    const key = `${userId}|${date}`;
    if (!shiftCache.has(key)) shiftCache.set(key, shiftWindowFor(assignments.get(userId) ?? [], date, input.tz));
    return shiftCache.get(key)!;
  };
  return {
    timeline,
    graceMinutes,
    calendar,
    shiftFor,
    factsFor: (userId, date) => dayFactsOf({
      bucket: timeline.bucket(userId, date),
      status: calendar.dayStatusFor(userId, date),
      shift: shiftFor(userId, date),
      graceMinutes,
      halfDayLateAfterMs: halfDayLateAfterMs(date, input.tz, policy.halfDayLateAfterMinute),
    }),
  };
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

export interface TimelineEntryMeta {
  id: string;
  source: 'AUTO' | 'MANUAL';
  requestId: string | null;
  larkTaskGuid: string | null;
  notes: string | null;
  attendeeIds: string[];
}

/** Pieces re-pointed at the plain entry metadata the day view renders. */
export function withEntryMeta(pieces: readonly TimelineRowPiece[]): Array<TimelinePiece<TimelineEntryMeta>> {
  const metaById = new Map<string, TimelineEntryMeta>();
  return pieces.map((p) => {
    let meta = metaById.get(p.entry.id);
    if (!meta) {
      meta = {
        id: p.entry.id,
        source: p.entry.source === 'MANUAL' ? 'MANUAL' : 'AUTO',
        requestId: p.entry.manualTimeRequest?.id ?? null,
        larkTaskGuid: p.entry.larkTaskGuid,
        notes: p.entry.notes ?? null,
        attendeeIds: p.entry.attendees.map((a) => a.userId),
      };
      metaById.set(p.entry.id, meta);
    }
    return { ...p, entry: meta };
  });
}

/** Meeting stretches (`a`..`b`) — what activity scoring treats as protected. */
export function meetingIntervals(pieces: ReadonlyArray<TimelinePiece<unknown>>): Array<{ a: number; b: number }> {
  return pieces.filter((p) => p.kind === 'MEETING').map((p) => ({ a: p.start, b: p.end }));
}

/** Is this instant inside a reviewer invalidation for this user? */
export function invalidatedAt(
  invalidations: readonly TimelineInvalidation[],
): (userId: string, t: number) => boolean {
  const byUser = invalidationsByUser(invalidations);
  return (userId, t) => containsInstant(byUser.get(userId) ?? [], t);
}
