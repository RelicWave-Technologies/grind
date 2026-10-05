import type { Segment, TimeEntry } from './types';

/**
 * Server-authoritative clock clamp (the "never trust the client clock" guard).
 *
 * The agent stamps timestamps with the LAPTOP's wall clock. A clock that runs
 * fast, is set forward, or is tampered with would otherwise inflate billed
 * hours. So before persisting any uploaded entry, the server clamps every
 * timestamp to its OWN clock: nothing may sit beyond `now + skew`.
 *
 * Why a ceiling (not a floor): a forward clock OVER-credits — the dangerous
 * direction — so we cap the future. A backward/slow client clock only
 * UNDER-credits, which is safe (we never invent time), so we leave the past
 * alone.
 *
 * `skewMs` absorbs benign clock drift between the laptop and the server
 * (default 2 min) so honest users near the "now" boundary aren't trimmed.
 *
 * Pure + deterministic: `now` is injected, no Date, no I/O.
 */

export interface ClampResult {
  entry: TimeEntry;
  /**
   * True only if a timestamp sat beyond `now + skew` and was pulled back to
   * the ceiling — a real clock correction. Dropping a zero-length segment does
   * NOT set it (see `dropped`).
   */
  adjusted: boolean;
  /** One note per clamped timestamp, for telemetry / abuse detection. Empty when clean. */
  notes: string[];
  /**
   * Ids of segments left out because they carry no time: zero-length as sent
   * (older agents produce them), or collapsed to zero by the clamp itself.
   * The same rule `validateEntry` and `dropZeroLengthSegments` follow, so a
   * valid entry stays valid after clamping. Not a clock correction on its own.
   */
  dropped: string[];
}

export const DEFAULT_CLOCK_SKEW_MS = 2 * 60 * 1000;

export function clampEntryToServerClock(
  entry: TimeEntry,
  nowMs: number,
  skewMs: number = DEFAULT_CLOCK_SKEW_MS,
): ClampResult {
  const ceiling = nowMs + Math.max(0, skewMs);
  const notes: string[] = [];
  const dropped: string[] = [];

  const clampTs = (ts: number, label: string): number => {
    if (ts > ceiling) {
      notes.push(`${label} ${ts} > ceiling ${ceiling} (clamped)`);
      return ceiling;
    }
    return ts;
  };

  const entryStart = clampTs(entry.startedAt, 'entry.startedAt');
  const entryEnd = entry.endedAt === null ? null : clampTs(entry.endedAt, 'entry.endedAt');

  const segments: Segment[] = [];
  for (const s of entry.segments) {
    const startedAt = clampTs(s.startedAt, `seg[${s.id}].startedAt`);
    const endedAt = s.endedAt === null ? null : clampTs(s.endedAt, `seg[${s.id}].endedAt`);
    // A zero-length segment carries no worked time — whether it arrived that
    // way or the clamp collapsed it — so it is never persisted.
    if (endedAt !== null && Math.trunc(endedAt) <= Math.trunc(startedAt)) {
      dropped.push(s.id);
      continue;
    }
    segments.push({ ...s, startedAt, endedAt });
  }

  return {
    entry: { ...entry, startedAt: entryStart, endedAt: entryEnd, segments },
    adjusted: notes.length > 0,
    notes,
    dropped,
  };
}
