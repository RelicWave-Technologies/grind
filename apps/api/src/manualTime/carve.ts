import type { Prisma } from '@grind/db';
import { freeSlices, type Span } from '../insights/overlap';

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
 * idle trim is the main thing manual time is for.
 */

/** A read of an existing segment, resolved to concrete bounds. */
type Client = Prisma.TransactionClient;

export interface CarveResult {
  /** Free stretches, in order. Empty means the window is fully accounted for. */
  slices: Span[];
  /** Milliseconds the request asked for that were already tracked. */
  trimmedMs: number;
}

/**
 * Which parts of `[start, end)` this user has not already got real time for.
 *
 * `ignoreEntryId` lets an approval re-run skip the entry it created last time,
 * so retrying a decision is idempotent rather than self-blocking.
 */
export async function carveManualWindow(
  tx: Client,
  args: { userId: string; start: Date; end: Date; ignoreEntryId?: string | null },
): Promise<CarveResult> {
  const startMs = args.start.getTime();
  const endMs = args.end.getTime();
  if (!(endMs > startMs)) return { slices: [], trimmedMs: 0 };

  const rows = await tx.timeSegment.findMany({
    where: {
      timeEntry: {
        userId: args.userId,
        ...(args.ignoreEntryId ? { id: { not: args.ignoreEntryId } } : {}),
      },
      // IDLE_TRIMMED is explicitly not worked time, so it must not stand in the
      // way of a claim that says otherwise.
      kind: { not: 'IDLE_TRIMMED' },
      startedAt: { lt: args.end },
      OR: [{ endedAt: null }, { endedAt: { gt: args.start } }],
    },
    select: { startedAt: true, endedAt: true },
  });

  // An open segment is a timer still running: treat it as occupying up to the
  // end of the window under consideration, never beyond.
  const occupied: Span[] = rows.map((r) => ({
    startedAt: r.startedAt.getTime(),
    endedAt: (r.endedAt ?? args.end).getTime(),
  }));

  const slices = freeSlices({ startedAt: startMs, endedAt: endMs }, occupied);
  const freeMs = slices.reduce((sum, s) => sum + (s.endedAt - s.startedAt), 0);
  return { slices, trimmedMs: endMs - startMs - freeMs };
}

/** Prisma nested-create payload for the carved slices. */
export function segmentCreateData(
  slices: readonly Span[],
  nextId: () => string,
): Array<{ id: string; kind: 'WORK'; startedAt: Date; endedAt: Date }> {
  return slices.map((s) => ({
    id: nextId(),
    kind: 'WORK' as const,
    startedAt: new Date(s.startedAt),
    endedAt: new Date(s.endedAt),
  }));
}
