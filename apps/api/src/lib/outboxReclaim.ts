import { logger } from '../logger';

/**
 * Stale-claim recovery for DB-backed outboxes.
 *
 * Outbox workers claim a row by flipping it PENDING → PROCESSING with a
 * `lockedAt` stamp, then settle it to DONE / PENDING / FAILED. A process that
 * dies between the two — a deploy, an OOM, a crash — leaves the row PROCESSING
 * forever: no worker claims it again, and the message it carries is never sent.
 *
 * A claim older than {@link OUTBOX_STALE_LOCK_MS} is therefore treated as
 * abandoned and handed back to PENDING. The window is far longer than any one
 * event takes (every outbound call is bounded at 15s), so a live worker's claim
 * is never stolen.
 *
 * Shared on purpose: each outbox passes its own updateMany, so this works for
 * any table with status / lockedAt / lockedBy columns.
 */
export const OUTBOX_STALE_LOCK_MS = 5 * 60_000;

export function staleOutboxLockCutoff(now: Date = new Date(), staleMs: number = OUTBOX_STALE_LOCK_MS): Date {
  return new Date(now.getTime() - staleMs);
}

/**
 * Hand abandoned PROCESSING rows back to PENDING. `reclaim` receives the cutoff
 * and must update rows `WHERE status = 'PROCESSING' AND lockedAt < cutoff`,
 * clearing lockedAt / lockedBy.
 */
export async function reclaimStaleOutboxClaims(
  outbox: string,
  reclaim: (cutoff: Date) => Promise<{ count: number }>,
  now: Date = new Date(),
): Promise<number> {
  const { count } = await reclaim(staleOutboxLockCutoff(now));
  if (count > 0) logger.warn({ outbox, reclaimed: count }, 'outbox: reclaimed abandoned PROCESSING claims');
  return count;
}
