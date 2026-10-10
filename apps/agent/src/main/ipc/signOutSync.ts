import Database from 'better-sqlite3';
import { app } from 'electron';
import path from 'node:path';

/**
 * Whether tracked time is safe to leave behind at sign-out.
 *
 * Sign-out used to ask "is anything unsynced?" after a single drain pass. That
 * pass covers at most one batch and skips rows waiting out a retry backoff, so
 * a long backlog — or one entry the server refuses for good — refused sign-out
 * (and with it every account switch) forever.
 *
 * Now the owner's backoff is cleared, the backlog is drained until a pass
 * stops making progress, and sign-out is refused only while something is
 * still failing for a reason that can pass (no network, a 5xx, never tried).
 * Entries the server itself refused (a 4xx) — including the timer's "parked"
 * rows — do not block: they stay on this machine, stamped with their owner,
 * and are retried when that person signs in again.
 */

export interface SignOutOwner {
  userId: string;
  workspaceId: string;
}

export interface SignOutBacklog {
  /** The owner's entries still waiting to reach the server. */
  pending: number;
  /** Of those, failing for a reason that can pass — these refuse sign-out. */
  transient: number;
  /** Of those, refused by the server with a 4xx. */
  refused: number;
  /** Of the refused, given up on by the timer (≥ {@link PARK_AFTER_ATTEMPTS} attempts). */
  parked: number;
}

/** Matches the timer's parked rows: this many failed attempts with a definitive 4xx. */
export const PARK_AFTER_ATTEMPTS = 5;
const MAX_DRAIN_ROUNDS = 20;

/**
 * A push error the server answered with a 4xx that retrying cannot change —
 * not auth, timeout or throttling. Errors are recorded as `http_<status>[:code]`.
 */
export function isServerRefusal(lastError: string | null): boolean {
  const status = /^http_(\d{3})\b/u.exec(lastError ?? '')?.[1];
  if (!status) return false;
  const code = Number(status);
  return code >= 400 && code < 500 && ![401, 403, 408, 429].includes(code);
}

/** Read/write view of the timer's local queue (`local_entries` in agent.db) for sign-out. */
export class SignOutSyncLedger {
  constructor(private readonly db: Database.Database) {}

  private hasQueue(): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_entries'`).get());
  }

  /** Make every waiting entry of the owner due now — sign-out should not wait out a backoff. */
  clearBackoff(owner: SignOutOwner): number {
    if (!this.hasQueue()) return 0;
    const info = this.db
      .prepare(
        `UPDATE local_entries SET next_attempt_at = NULL
         WHERE owner_user_id = ? AND owner_workspace_id = ?
           AND sync_state IN ('pending_create', 'pending_update') AND next_attempt_at IS NOT NULL`,
      )
      .run(owner.userId, owner.workspaceId);
    return Number(info.changes ?? 0);
  }

  backlog(owner: SignOutOwner): SignOutBacklog {
    const out: SignOutBacklog = { pending: 0, transient: 0, refused: 0, parked: 0 };
    if (!this.hasQueue()) return out;
    const rows = this.db
      .prepare(
        `SELECT sync_attempts AS attempts, last_error AS lastError FROM local_entries
         WHERE owner_user_id = ? AND owner_workspace_id = ?
           AND sync_state IN ('pending_create', 'pending_update')`,
      )
      .all(owner.userId, owner.workspaceId) as Array<{ attempts: number | null; lastError: string | null }>;
    for (const row of rows) {
      out.pending += 1;
      if (isServerRefusal(row.lastError)) {
        out.refused += 1;
        if (Number(row.attempts ?? 0) >= PARK_AFTER_ATTEMPTS) out.parked += 1;
      } else {
        out.transient += 1;
      }
    }
    return out;
  }
}

let ledger: SignOutSyncLedger | null = null;

export function getSignOutLedger(): SignOutSyncLedger {
  ledger ??= new SignOutSyncLedger(new Database(path.join(app.getPath('userData'), 'agent.db')));
  return ledger;
}

/**
 * Drain the owner's timer backlog as far as it will go. `ok` is false only
 * when entries are still failing for a reason that can pass.
 */
export async function syncBeforeSignOut(args: {
  ledger: SignOutSyncLedger;
  owner: SignOutOwner | null;
  drain: () => Promise<void>;
  maxRounds?: number;
}): Promise<{ ok: boolean; backlog: SignOutBacklog }> {
  const { ledger: queue, owner, drain, maxRounds = MAX_DRAIN_ROUNDS } = args;
  if (!owner) return { ok: true, backlog: { pending: 0, transient: 0, refused: 0, parked: 0 } };

  queue.clearBackoff(owner);
  let backlog = queue.backlog(owner);
  for (let round = 0; round < maxRounds && backlog.pending > 0; round += 1) {
    await drain().catch(() => undefined);
    const next = queue.backlog(owner);
    const progressed = next.pending < backlog.pending;
    backlog = next;
    if (!progressed) break;
    // Rows that failed in this pass were pushed back; the next pass should try them again.
    queue.clearBackoff(owner);
  }
  return { ok: backlog.transient === 0, backlog };
}
