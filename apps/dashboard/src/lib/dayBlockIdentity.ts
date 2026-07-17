import type { DayBlock } from './types';

/**
 * Stable identity for a visible day block.
 *
 * A single TimeEntry can produce several WORK / MEETING segments after
 * pause-resume cycles. `timeEntryId` alone is therefore not a React key. The
 * segment's original start is durable, while its end can change as an open
 * timer refreshes, so the end deliberately stays out of this identity.
 */
export function dayBlockRowId(block: Pick<DayBlock, 'kind' | 'startedAt' | 'endedAt' | 'timeEntryId' | 'requestId'>): string {
  switch (block.kind) {
    case 'GAP':
      return `gap-${block.startedAt}-${block.endedAt}`;
    case 'PENDING':
      return `pending-${block.requestId ?? block.startedAt}`;
    case 'IDLE_TRIMMED':
      return `idle-${block.startedAt}`;
    default:
      return `entry-${block.timeEntryId ?? 'unlinked'}-${block.kind.toLowerCase()}-${block.startedAt}`;
  }
}
