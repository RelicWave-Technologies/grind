/**
 * Domain types for time tracking. Time is represented as epoch milliseconds
 * (plain numbers) so all logic is pure, deterministic, and trivially testable
 * without a clock, DB, or Electron.
 */

export type SegmentKind = 'WORK' | 'MEETING' | 'IDLE_TRIMMED';

export type TimeEntrySource = 'AUTO' | 'MANUAL';

export type TimeEntryPauseReason = 'IDLE' | 'PERMISSION_REQUIRED';

export type TimeEntryCloseReason =
  | 'AGENT'
  | 'AGENT_RECOVERY'
  | 'LEASE_EXPIRED'
  | 'SUPERSEDED'
  | 'LEGACY_RECONCILED';

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
  /** Monotonic local mutation revision. Legacy local rows normalize to 0. */
  revision: number;
  /** epoch ms; equals the first segment's startedAt */
  startedAt: number;
  /** epoch ms; null while the entry is still running */
  endedAt: number | null;
  /** Why a still-open entry currently has no accruing segment. Agent-local. */
  pauseReason: TimeEntryPauseReason | null;
  /** Agent-side closure intent persisted with the retryable local snapshot. */
  closeReason: Extract<TimeEntryCloseReason, 'AGENT' | 'AGENT_RECOVERY'> | null;
  segments: Segment[];
}

/** Durations that count as worked time. IDLE_TRIMMED never counts. */
export const COUNTED_KINDS: readonly SegmentKind[] = ['WORK', 'MEETING'];
