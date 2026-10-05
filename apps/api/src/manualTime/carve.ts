import type { Prisma } from '@grind/db';
import {
  effectiveEntrySegmentEnds,
  freeSlices,
  intersectIntervals,
  mergeIntervals,
  type Interval,
} from '@grind/core';
import { loadEntryLiveEvidence } from '../insights/liveEntryEvidence';

/**
 * Manual time is stored as only the stretches that are actually free.
 *
 * An approved request becomes a real TimeEntry, and nothing stopped one from
 * covering minutes the agent had already tracked. Every reader that sums
 * durations then counted those minutes twice — the day totals, the timesheet
 * cells, and through them payroll.
 *
 * Trimming here rather than at read time means the overlap never exists in the
 * first place: exports, the MCP surface, Lark cards and anything written later
 * are all correct without knowing this rule.
 *
 * Observed time wins. Trimmed idle does not block a claim — correcting a bad
 * idle trim is the main thing manual time is for. An open segment occupies
 * only as far as its proof reaches (`effectiveEntrySegmentEnds`, the same rule
 * every screen applies): a legacy timer left open with its last screenshot at
 * 09:40 does not swallow an approved request for 10:00–12:00.
 *
 * Callers that write carved time must hold `lockManualCarve` for the user, so
 * two approvals cannot both claim the same free minutes.
 */

type Client = Prisma.TransactionClient;

export interface CarveResult {
  /** Free stretches, in order. Empty means the window is fully accounted for. */
  slices: Interval[];
  /** Milliseconds the request asked for that were already tracked. */
  trimmedMs: number;
}

/**
 * Serialise every write of carved manual time for one user, for the rest of
 * the transaction. Take it after locking the request row, never before.
 */
export async function lockManualCarve(tx: Client, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`manual-carve:${userId}`}))`;
}

/** Everything this user already has in `[start, end)`, idle excluded. */
async function occupiedTime(
  tx: Client,
  args: { userId: string; start: Date; end: Date; ignoreEntryId?: string | null; now?: Date },
): Promise<Interval[]> {
  const now = args.now ?? new Date();
  const rows = await tx.timeEntry.findMany({
    where: {
      userId: args.userId,
      ...(args.ignoreEntryId ? { id: { not: args.ignoreEntryId } } : {}),
      startedAt: { lt: args.end },
      OR: [{ endedAt: null }, { endedAt: { gt: args.start } }],
    },
    select: {
      id: true,
      userId: true,
      endedAt: true,
      trackingProtocolVersion: true,
      lastProvenAt: true,
      leaseExpiresAt: true,
      segments: { select: { kind: true, startedAt: true, endedAt: true } },
    },
  });
  const evidence = await loadEntryLiveEvidence(rows, now);
  const occupied: Interval[] = [];
  for (const row of rows) {
    const ends = effectiveEntrySegmentEnds({
      segments: row.segments,
      entryEndedAt: row.endedAt,
      now,
      evidence: evidence.get(row.id),
      lifecycle: row,
    });
    row.segments.forEach((segment, index) => {
      // IDLE_TRIMMED is explicitly not worked time, so it must not stand in
      // the way of a claim that says otherwise.
      if (segment.kind === 'IDLE_TRIMMED') return;
      const end = ends[index];
      // A timer proven live right now occupies the rest of the window.
      occupied.push({ start: segment.startedAt.getTime(), end: end ? end.getTime() : args.end.getTime() });
    });
  }
  return mergeIntervals(occupied);
}

/**
 * Which parts of `[start, end)` this user has not already got real time for.
 *
 * `ignoreEntryId` lets an approval re-run skip the entry it created last time,
 * so retrying a decision is idempotent rather than self-blocking.
 */
export async function carveManualWindow(
  tx: Client,
  args: { userId: string; start: Date; end: Date; ignoreEntryId?: string | null; now?: Date },
): Promise<CarveResult> {
  const window = { start: args.start.getTime(), end: args.end.getTime() };
  if (!(window.end > window.start)) return { slices: [], trimmedMs: 0 };
  const slices = freeSlices(window, await occupiedTime(tx, args));
  const freeMs = slices.reduce((sum, s) => sum + (s.end - s.start), 0);
  return { slices, trimmedMs: window.end - window.start - freeMs };
}

/** Prisma nested-create payload for the carved slices. */
export function segmentCreateData(
  slices: readonly Interval[],
  nextId: () => string,
): Array<{ id: string; kind: 'WORK'; startedAt: Date; endedAt: Date }> {
  return slices.map((s) => ({
    id: nextId(),
    kind: 'WORK' as const,
    startedAt: new Date(s.start),
    endedAt: new Date(s.end),
  }));
}

/**
 * Give back minutes a deleted manual entry was holding.
 *
 * Another approved request carved around that entry, so deleting it would
 * leave a hole nobody owns. Each approved request of this user overlapping the
 * freed stretches (oldest decision first) takes back the part of its own
 * window that is now free — and only that: trims made to it for any other
 * reason stay as they are.
 *
 * Call with `lockManualCarve` held.
 */
export async function refillFreedManualTime(
  tx: Client,
  args: { userId: string; freed: readonly Interval[]; nextId: () => string; now?: Date },
): Promise<number> {
  const freed = mergeIntervals(args.freed);
  if (freed.length === 0) return 0;
  const span = { start: freed[0]!.start, end: freed[freed.length - 1]!.end };
  const requests = await tx.manualTimeRequest.findMany({
    where: {
      userId: args.userId,
      status: 'APPROVED',
      requestedStart: { lt: new Date(span.end) },
      requestedEnd: { gt: new Date(span.start) },
    },
    orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      userId: true,
      timeEntryId: true,
      requestedStart: true,
      requestedEnd: true,
      larkTaskGuid: true,
      attendees: { select: { userId: true } },
    },
  });

  let refilled = 0;
  for (const r of requests) {
    const reclaim = intersectIntervals([{ start: r.requestedStart.getTime(), end: r.requestedEnd.getTime() }], freed);
    if (reclaim.length === 0) continue;
    const occupied = await occupiedTime(tx, {
      userId: r.userId,
      start: new Date(reclaim[0]!.start),
      end: new Date(reclaim[reclaim.length - 1]!.end),
      now: args.now,
    });
    const slices = mergeIntervals(reclaim.flatMap((iv) => freeSlices(iv, occupied)));
    if (slices.length === 0) continue;
    refilled += slices.reduce((sum, s) => sum + (s.end - s.start), 0);

    if (r.timeEntryId) {
      const entry = await tx.timeEntry.findUnique({
        where: { id: r.timeEntryId },
        select: { startedAt: true, endedAt: true },
      });
      if (!entry) continue;
      await tx.timeSegment.createMany({
        data: segmentCreateData(slices, args.nextId).map((s) => ({ ...s, timeEntryId: r.timeEntryId! })),
      });
      await tx.timeEntry.update({
        where: { id: r.timeEntryId },
        data: {
          startedAt: new Date(Math.min(entry.startedAt.getTime(), slices[0]!.start)),
          endedAt: new Date(Math.max(entry.endedAt?.getTime() ?? 0, slices[slices.length - 1]!.end)),
        },
      });
    } else {
      // Approved with nothing free at the time; it can have the minutes now.
      const id = args.nextId();
      await tx.timeEntry.create({
        data: {
          id,
          clientUuid: `mtr-${r.id}`,
          userId: r.userId,
          larkTaskGuid: r.larkTaskGuid,
          source: 'MANUAL',
          startedAt: new Date(slices[0]!.start),
          endedAt: new Date(slices[slices.length - 1]!.end),
          segments: { create: segmentCreateData(slices, args.nextId) },
          attendees: r.attendees.length ? { create: r.attendees.map((a) => ({ userId: a.userId })) } : undefined,
        },
      });
      await tx.manualTimeRequest.update({ where: { id: r.id }, data: { timeEntryId: id } });
    }
  }
  return refilled;
}
