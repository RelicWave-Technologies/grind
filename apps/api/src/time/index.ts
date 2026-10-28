import { prisma, type Prisma } from '@grind/db';
import {
  bucketByDay,
  containsInstant,
  isCounted,
  trackingNow,
  emptyDayBucket,
  invalidationsByUser,
  resolveTimeline,
  shiftWindowFor,
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
} from '@grind/types';
import { punchInMs, type PunchLookup } from '../attendance/punches';
import { loadEntryLiveEvidence } from '../insights/liveEntryEvidence';

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
  manualTimeRequest: { select: { id: true, reason: true } },
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

const { segments: _segments, attendees: _attendees, manualTimeRequest: _manual, ...TIMELINE_ENTRY_SCALARS } = TIMELINE_ENTRY_SELECT;

/**
 * The entries matching `where`, with their segments, attendees and manual
 * request — the `TIMELINE_ENTRY_SELECT` shape.
 *
 * Read as four queries side by side rather than one nested select: a nested
 * select makes Prisma fetch each relation with an `IN` list of every entry id,
 * which for a workspace's month (~10k entries) took over two seconds; filtering
 * each relation by the same entry filter takes a fraction of that.
 */
async function loadTimelineEntries(where: Prisma.TimeEntryWhereInput): Promise<TimelineRow[]> {
  const [rows, segments, attendees, manual] = await Promise.all([
    prisma.timeEntry.findMany({
      where,
      select: TIMELINE_ENTRY_SCALARS,
      orderBy: [{ userId: 'asc' }, { startedAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.timeSegment.findMany({
      where: { timeEntry: where },
      select: { id: true, timeEntryId: true, kind: true, startedAt: true, endedAt: true },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.timeEntryAttendee.findMany({ where: { timeEntry: where }, select: { timeEntryId: true, userId: true } }),
    prisma.manualTimeRequest.findMany({ where: { timeEntry: where }, select: { id: true, reason: true, timeEntryId: true } }),
  ]);
  const segmentsOf = new Map<string, TimelineRow['segments']>();
  for (const { timeEntryId, ...segment } of segments) {
    const list = segmentsOf.get(timeEntryId);
    if (list) list.push(segment);
    else segmentsOf.set(timeEntryId, [segment]);
  }
  const attendeesOf = new Map<string, TimelineRow['attendees']>();
  for (const { timeEntryId, userId } of attendees) {
    const list = attendeesOf.get(timeEntryId);
    if (list) list.push({ userId });
    else attendeesOf.set(timeEntryId, [{ userId }]);
  }
  const manualOf = new Map(manual.map((m) => [m.timeEntryId, { id: m.id, reason: m.reason }]));
  return rows.map((row) => ({
    ...row,
    segments: segmentsOf.get(row.id) ?? [],
    attendees: attendeesOf.get(row.id) ?? [],
    manualTimeRequest: manualOf.get(row.id) ?? null,
  }));
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
  /**
   * Narrow the read further. Owners are resolved among what is read, so a
   * narrowing must keep every entry that overlaps the instants the caller
   * will look at.
   */
  where?: Prisma.TimeEntryWhereInput;
}): Promise<LoadedTimeline> {
  const now = input.now ?? new Date();
  const readStart = new Date(input.start.getTime() - (input.lookbackMs ?? DAY_MS));
  const userIds = [...new Set(input.userIds)];
  if (userIds.length === 0 || input.end <= readStart) {
    return { start: input.start, end: input.end, now, entries: [], evidence: new Map(), invalidations: [], pieces: [] };
  }
  const where: Prisma.TimeEntryWhereInput = {
    userId: { in: userIds },
    startedAt: { lt: input.end },
    OR: [{ endedAt: null }, { endedAt: { gt: readStart } }],
    ...(input.where ? { AND: [input.where] } : {}),
  };
  const [entries, invalidations] = await Promise.all([
    loadTimelineEntries(where),
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

/**
 * Who is tracking right now (userId → the running entry's id), from the
 * shared timeline. Only an open entry can be live, so the read is a sliver at
 * `now` — the open entries and nothing else.
 */
export async function loadTrackingNow(userIds: readonly string[], now = new Date()): Promise<Map<string, string>> {
  const { pieces } = await loadTimelineWindow({
    userIds,
    start: now,
    end: new Date(now.getTime() + 1),
    now,
    lookbackMs: 0,
    where: { endedAt: null },
  });
  return trackingNow(pieces);
}

/**
 * What approved manual-time requests count for, by request id: the counted
 * time their entries own on the shared timeline.
 *
 * Approval stores only the minutes that were free at the time, but tracked
 * time that syncs later still takes a minute back, and a reviewer's
 * invalidation still removes one — the stored segments know neither. A
 * request that is not approved added nothing and is absent from the map.
 */
export async function loadCreditedManualMs(
  requests: ReadonlyArray<{ id: string; userId: string; status: string; requestedStart: Date; requestedEnd: Date }>,
  now = new Date(),
): Promise<Map<string, number>> {
  const approved = requests.filter((r) => r.status === 'APPROVED' && r.requestedEnd > r.requestedStart);
  const out = new Map<string, number>();
  if (approved.length === 0) return out;
  // Approval carves inside the requested window, so the request's time and
  // everything that can contest it overlap that window: read just those.
  const { pieces } = await loadTimelineWindow({
    userIds: approved.map((r) => r.userId),
    start: new Date(Math.min(...approved.map((r) => r.requestedStart.getTime()))),
    end: new Date(Math.max(...approved.map((r) => r.requestedEnd.getTime()))),
    now,
    lookbackMs: 0,
    where: {
      OR: approved.map((r) => ({
        userId: r.userId,
        startedAt: { lt: r.requestedEnd },
        OR: [{ endedAt: null }, { endedAt: { gt: r.requestedStart } }],
      })),
    },
  });
  for (const r of approved) out.set(r.id, 0);
  for (const piece of pieces) {
    const requestId = piece.entry.manualTimeRequest?.id;
    if (!requestId || !out.has(requestId) || !isCounted(piece)) continue;
    out.set(requestId, out.get(requestId)! + (piece.end - piece.start));
  }
  return out;
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
  status: DayStatus | null;
  shift: ShiftDay<ShiftAssignmentRow> | null;
  /** The door punch-in as an instant (see `punchInMs`); null when nobody punched in. */
  punchInMs: number | null;
}

/**
 * What a day's arrival is judged on, for `userIds` over `[from, to]`: the
 * Working Calendar status, the shift assigned for that date and the door
 * punch-in — the inputs to the one late definition in core. Lateness itself is
 * judged by the caller (`isLateArrival`), which knows the person's
 * attendance-rule mode and the policy.
 *
 * Two halves, so a caller can put the one read (the shift assignments) in the
 * same round as its other reads: `loadDayFactAssignments`, then
 * `dayFactsFrom`.
 */
export async function loadDayFactAssignments(input: {
  userIds: readonly string[];
  from: string;
  to: string;
  tz: string;
}): Promise<Map<string, ShiftAssignmentRow[]>> {
  const first = localDayWindowInTimeZone(input.from, input.tz);
  const last = localDayWindowInTimeZone(input.to, input.tz);
  if (!first || !last) throw new Error('invalid_date_or_tz');
  return loadShiftAssignments([...new Set(input.userIds)], first.start, last.end);
}

/** The day facts over assignments loaded with `loadDayFactAssignments`. */
export function dayFactsFrom(
  assignments: Map<string, ShiftAssignmentRow[]>,
  input: {
    tz: string;
    calendar: { dayStatusFor(userId: string, date: string): DayStatus | null };
    punchFor: PunchLookup;
  },
): { factsFor(userId: string, date: string): DayFacts } {
  return {
    factsFor: (userId, date) => ({
      status: input.calendar.dayStatusFor(userId, date),
      shift: shiftWindowFor(assignments.get(userId) ?? [], date, input.tz),
      punchInMs: punchInMs(input.punchFor(userId, date), date, input.tz),
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
  /** Why the manual time was asked for — the request's reason. Null for tracked time. */
  reason: string | null;
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
        reason: p.entry.manualTimeRequest?.reason ?? null,
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
