/**
 * Domain types for time tracking. Time is represented as epoch milliseconds
 * (plain numbers) so all logic is pure, deterministic, and trivially testable
 * without a clock, DB, or Electron.
 */

export type SegmentKind = 'WORK' | 'MEETING' | 'IDLE_TRIMMED';

export type TimeEntrySource = 'AUTO' | 'MANUAL';

export interface Segment {
  id: string;
  kind: SegmentKind;
  /** epoch ms, inclusive start */
  startedAt: number;
  /** epoch ms, exclusive end; null = currently open */
  endedAt: number | null;
}

export interface TimeEntry {
  id: string;
  /** client-generated idempotency key (ULID) */
  clientUuid: string;
  userId: string;
  /** Lark Task v2 GUID this entry is attributed to, if any. */
  larkTaskGuid?: string | null;
  source: TimeEntrySource;
  /** epoch ms; equals the first segment's startedAt */
  startedAt: number;
  /** epoch ms; null while the entry is still running */
  endedAt: number | null;
  segments: Segment[];
}

/** Durations that count as worked time. IDLE_TRIMMED never counts. */
export const COUNTED_KINDS: readonly SegmentKind[] = ['WORK', 'MEETING'];
