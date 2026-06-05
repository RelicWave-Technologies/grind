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
  /** True if any timestamp was pulled back to the ceiling. */
  adjusted: boolean;
  /** Per-field notes, for telemetry / abuse detection. Empty when clean. */
  notes: string[];
}

export const DEFAULT_CLOCK_SKEW_MS = 2 * 60 * 1000;

export function clampEntryToServerClock(
  entry: TimeEntry,
  nowMs: number,
  skewMs: number = DEFAULT_CLOCK_SKEW_MS,
): ClampResult {
  const ceiling = nowMs + Math.max(0, skewMs);
  const notes: string[] = [];

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
    // A segment whose end clamped back to/under its start carries no real
    // worked time — drop it rather than persist a zero/negative span.
    if (endedAt !== null && endedAt <= startedAt) {
      notes.push(`seg[${s.id}] dropped (zero-length after clamp)`);
      continue;
    }
    segments.push({ ...s, startedAt, endedAt });
  }

  return {
    entry: { ...entry, startedAt: entryStart, endedAt: entryEnd, segments },
    adjusted: notes.length > 0,
    notes,
  };
}
