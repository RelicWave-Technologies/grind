import { HttpError } from '../apiClient';

/**
 * What a failed push means, and how long to leave it.
 *
 * Two kinds of failure, handled at two levels:
 *
 *  - The SERVER could not be reached or could not cope (no response, 5xx, 429,
 *    408, signed out). Nothing is wrong with the row; every other row would
 *    fail the same way. The whole drain stops at the first one and waits —
 *    exponentially, and never less than a Retry-After the server sent.
 *  - The server REFUSED this row (any other 4xx, or an answer that does not
 *    acknowledge it). The rest of the queue is fine; this row backs off on its
 *    own, and after PARK_AFTER_ATTEMPTS refusals it is parked for a day so a
 *    row the server will never take cannot be resent forever. It stays in the
 *    queue (nothing tracked is dropped) and is reported in the diagnostics.
 *
 * Together these bound every resend: no row is ever pushed again before its own
 * retry time, and nothing is pushed at all while the server is unreachable.
 */

/** Refusals of one row before it is parked. */
export const PARK_AFTER_ATTEMPTS = 5;
/** How long a parked row waits before one more try. */
export const PARKED_RETRY_MS = 24 * 60 * 60_000;

/** Wait after the Nth consecutive failure: 30s, 1m, 2m, 4m, 8m, then 15m. */
export function syncRetryDelayMs(failures: number): number {
  return Math.min(15 * 60_000, 30_000 * 2 ** Math.max(0, failures - 1));
}

/** When a row refused `attempts` times in a row may be pushed again. */
export function rowRetryAt(now: number, attempts: number): number {
  return now + (attempts >= PARK_AFTER_ATTEMPTS ? PARKED_RETRY_MS : syncRetryDelayMs(attempts));
}

export type SyncFailure =
  | { scope: 'server'; error: string; retryAfterMs: number | null; noResponse: boolean }
  | { scope: 'row'; error: string };

export function classifySyncFailure(err: unknown): SyncFailure {
  const error = describeSyncError(err);
  if (err instanceof HttpError) {
    const { status } = err;
    if (status >= 500 || status === 429 || status === 408) {
      return { scope: 'server', error, retryAfterMs: err.retryAfterMs, noResponse: false };
    }
    return { scope: 'row', error };
  }
  // A reply we could not read is about that reply, not about reachability.
  if (err instanceof Error && err.name === 'ZodError') return { scope: 'row', error };
  // No response at all (ApiNetworkError), or signed out (UnauthorizedError).
  return { scope: 'server', error, retryAfterMs: null, noResponse: true };
}

/** The drain-wide pause after the server could not be reached. */
export class SyncPause {
  private until: number | null = null;
  private failures = 0;
  private noResponse = false;
  lastError: string | null = null;

  isPaused(now: number): boolean {
    return this.until !== null && now < this.until;
  }

  note(failure: Extract<SyncFailure, { scope: 'server' }>, now: number): void {
    this.failures += 1;
    this.noResponse = failure.noResponse;
    this.lastError = failure.error;
    this.until = now + Math.max(syncRetryDelayMs(this.failures), failure.retryAfterMs ?? 0);
  }

  /** A push got through: the server is back. */
  clear(): void {
    this.until = null;
    this.failures = 0;
    this.noResponse = false;
    this.lastError = null;
  }

  /**
   * Another request just got an answer. A pause for "no response" is over —
   * but one the server asked for (5xx, 429, Retry-After) still stands.
   */
  noteReachable(): void {
    if (this.noResponse) this.clear();
  }
}

/** Short, stable reason for the heartbeat diagnostics, e.g. `http_409:timer_conflict`. */
export function describeSyncError(err: unknown): string {
  if (err instanceof HttpError) {
    let code = '';
    try {
      const body = JSON.parse(err.body) as { error?: unknown };
      if (typeof body.error === 'string') code = `:${body.error}`;
    } catch {
      // Not JSON; the status alone still says enough.
    }
    return `http_${err.status}${code}`;
  }
  return err instanceof Error ? `${err.name}:${err.message}`.slice(0, 200) : 'unknown_error';
}
