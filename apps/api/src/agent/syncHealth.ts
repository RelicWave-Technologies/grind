import type { AgentDiagnostics } from '@grind/types';

/**
 * Timo sync health: is tracked time leaving the laptop?
 *
 * Every heartbeat that carries diagnostics reports the agent's upload queue —
 * how many entries are still pending, the start of the oldest one, and the
 * last error a pending entry got. This module turns that into one verdict per
 * person, for the People table, the Overview card and the stuck-sync alert:
 *
 *   HEALTHY  nothing pending, or nothing pending for longer than 10 minutes
 *   BEHIND   something has been pending for more than 10 minutes
 *   STUCK    something has been pending for more than 2 hours, or the same
 *            sync error has repeated for more than 30 minutes
 *   UNKNOWN  no agent, an agent too old to report diagnostics, or a last
 *            report older than 15 minutes (the agent is offline) — the
 *            last-known verdict and its age are still returned
 *
 * "Pending for" is measured on the SERVER's clock wherever possible. The
 * agent's oldest-pending time is when that entry STARTED (a running timer
 * edited a second ago reports its start of hours ago), and a laptop clock can
 * be wrong, so it is only an upper bound: the age used is the smaller of
 *   - now − the oldest pending entry's start (never in the future), and
 *   - now − when the server first saw the queue non-empty, uninterrupted
 *     (`agentSyncPendingSince`, kept by the heartbeat — see
 *     `nextSyncTrackingColumns`).
 * The same goes for "the same error for 30 minutes": `agentSyncErrorSince` is
 * the server time that error was first reported.
 *
 * Pure: `now` is injected, no I/O.
 */

export const SYNC_BEHIND_AFTER_MS = 10 * 60_000;
export const SYNC_STUCK_AFTER_MS = 2 * 60 * 60_000;
export const SYNC_ERROR_STUCK_AFTER_MS = 30 * 60_000;
export const SYNC_DIAGNOSTICS_STALE_MS = 15 * 60_000;

/** Postgres INTEGER ceiling: a larger pending count is stored as this. */
export const MAX_STORED_PENDING = 2_147_483_647;

export type SyncHealthStatus = 'HEALTHY' | 'BEHIND' | 'STUCK' | 'UNKNOWN';

export type SyncHealthReason =
  | 'synced'
  | 'pending_recent'
  | 'pending_old'
  | 'pending_very_old'
  | 'error_repeating'
  | 'no_agent'
  | 'no_diagnostics'
  | 'stale_diagnostics';

export interface SyncHealthInput {
  agentVersion: string | null;
  agentPlatform: string | null;
  agentLastSeenAt: Date | null;
  agentOsVersion: string | null;
  agentArch: string | null;
  agentSyncPending: number | null;
  agentSyncOldestPendingAt: Date | null;
  agentSyncLastError: string | null;
  agentDiagnosticsUpdatedAt: Date | null;
  agentSyncPendingSince: Date | null;
  agentSyncErrorSince: Date | null;
}

/** Every User column the verdict reads — spread into a Prisma `select`. */
export const SYNC_HEALTH_SELECT = {
  agentVersion: true,
  agentPlatform: true,
  agentLastSeenAt: true,
  agentOsVersion: true,
  agentArch: true,
  agentSyncPending: true,
  agentSyncOldestPendingAt: true,
  agentSyncLastError: true,
  agentDiagnosticsUpdatedAt: true,
  agentSyncPendingSince: true,
  agentSyncErrorSince: true,
} as const;

export interface SyncHealthDto {
  status: SyncHealthStatus;
  reason: SyncHealthReason;
  /** For UNKNOWN with an old report: what that report said, judged when it arrived. */
  lastKnownStatus: Exclude<SyncHealthStatus, 'UNKNOWN'> | null;
  pending: number | null;
  /** How long the oldest pending entry has been waiting (see module doc). */
  oldestPendingAgeMs: number | null;
  lastError: string | null;
  lastErrorLabel: string | null;
  /** How long the same error has been repeating, on the server's clock. */
  lastErrorForMs: number | null;
  /** Server receive time of the last diagnostics report. */
  reportedAt: string | null;
  reportAgeMs: number | null;
  agentVersion: string | null;
  platform: string | null;
  osVersion: string | null;
  arch: string | null;
}

function ms(date: Date | null): number | null {
  if (!date) return null;
  const value = date.getTime();
  return Number.isFinite(value) ? value : null;
}

/** Judge the queue as of `at` (the report time for a stale report, else now). */
function judge(input: SyncHealthInput, at: number, reportedAt: number) {
  const pending = Math.max(0, input.agentSyncPending ?? 0);
  if (pending === 0) {
    return { status: 'HEALTHY' as const, reason: 'synced' as const, ageMs: null, errorForMs: null };
  }
  const candidates: number[] = [];
  const oldest = ms(input.agentSyncOldestPendingAt);
  // Never later than the report it came in: a laptop clock ahead of the
  // server would otherwise make the age negative.
  if (oldest !== null) candidates.push(at - Math.min(oldest, reportedAt));
  const since = ms(input.agentSyncPendingSince);
  if (since !== null) candidates.push(at - since);
  // Pending with no start and no server observation: it was just reported.
  const ageMs = Math.max(0, candidates.length > 0 ? Math.min(...candidates) : at - reportedAt);

  const errorSince = ms(input.agentSyncErrorSince);
  const errorForMs = input.agentSyncLastError && errorSince !== null ? Math.max(0, at - errorSince) : null;

  if (ageMs > SYNC_STUCK_AFTER_MS) return { status: 'STUCK' as const, reason: 'pending_very_old' as const, ageMs, errorForMs };
  if (errorForMs !== null && errorForMs > SYNC_ERROR_STUCK_AFTER_MS) {
    return { status: 'STUCK' as const, reason: 'error_repeating' as const, ageMs, errorForMs };
  }
  if (ageMs > SYNC_BEHIND_AFTER_MS) return { status: 'BEHIND' as const, reason: 'pending_old' as const, ageMs, errorForMs };
  return { status: 'HEALTHY' as const, reason: 'pending_recent' as const, ageMs, errorForMs };
}

export function classifySyncHealth(input: SyncHealthInput, now: Date = new Date()): SyncHealthDto {
  const nowMs = now.getTime();
  const reportedAt = ms(input.agentDiagnosticsUpdatedAt);
  const base = {
    lastError: input.agentSyncLastError,
    lastErrorLabel: syncErrorLabel(input.agentSyncLastError),
    reportedAt: input.agentDiagnosticsUpdatedAt?.toISOString() ?? null,
    reportAgeMs: reportedAt === null ? null : Math.max(0, nowMs - reportedAt),
    agentVersion: input.agentVersion,
    platform: input.agentPlatform,
    osVersion: input.agentOsVersion,
    arch: input.agentArch,
  };

  if (reportedAt === null) {
    const hasAgent = input.agentLastSeenAt !== null || input.agentVersion !== null;
    return {
      ...base,
      status: 'UNKNOWN',
      reason: hasAgent ? 'no_diagnostics' : 'no_agent',
      lastKnownStatus: null,
      pending: null,
      oldestPendingAgeMs: null,
      lastErrorForMs: null,
    };
  }

  const pending = input.agentSyncPending === null ? null : Math.max(0, input.agentSyncPending);
  if (nowMs - reportedAt > SYNC_DIAGNOSTICS_STALE_MS) {
    // Offline: show what the laptop last said, as of when it said it.
    const lastKnown = judge(input, reportedAt, reportedAt);
    return {
      ...base,
      status: 'UNKNOWN',
      reason: 'stale_diagnostics',
      lastKnownStatus: lastKnown.status,
      pending,
      oldestPendingAgeMs: lastKnown.ageMs,
      lastErrorForMs: lastKnown.errorForMs,
    };
  }

  const verdict = judge(input, nowMs, reportedAt);
  return {
    ...base,
    status: verdict.status,
    reason: verdict.reason,
    lastKnownStatus: null,
    pending,
    oldestPendingAgeMs: verdict.ageMs,
    lastErrorForMs: verdict.errorForMs,
  };
}

/**
 * Plain words for the error codes the agent reports (`http_<status>[:<code>]`
 * from the server, `<ErrorName>:<message>` for everything else). Null when
 * there is no error; the raw code is always shown beside it.
 */
export function syncErrorLabel(code: string | null): string | null {
  if (!code) return null;
  const known: Record<string, string> = {
    'http_409:timer_conflict': 'Another device holds the running timer',
    'http_409:active_timer_conflict': 'Another timer is already running on the server',
    'http_409:revision_payload_conflict': 'The server holds a different copy of this change',
    'http_409:segment_id_conflict': 'A time segment id is already used by another entry',
    'http_409:timer_protocol_required': 'This Timo version is too old for this entry',
    'http_409:client_uuid_conflict': 'The entry id clashes with another account',
    'http_409:client_uuid_entry_conflict': 'The entry id clashes with another entry',
    'http_400:invalid_segments': 'The server rejected the time segments',
    'http_400:validation_failed': 'The server rejected the upload format',
    'http_400:incomplete_timer_lifecycle': 'The server rejected the upload format',
    'http_403:forbidden': 'The entry belongs to another account',
    'http_404:not_found': 'The entry is missing on the server',
    unacknowledged_receipt: 'The server answered but did not confirm the upload',
  };
  if (known[code]) return known[code];
  if (/^UnauthorizedError:/u.test(code) || /^http_401\b/u.test(code)) return 'Signed out — the session expired';
  if (/cert|ssl|tls|self[- ]signed|UNABLE_TO_VERIFY|ERR_TLS/iu.test(code)) {
    return 'Secure connection failed (TLS/certificate — a proxy or antivirus?)';
  }
  if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|fetch failed|network|socket/iu.test(code)) {
    return 'Network unreachable';
  }
  if (/^(AbortError|TimeoutError)\b|timed? ?out/iu.test(code)) return 'The upload timed out';
  if (/^http_429\b/u.test(code)) return 'Rate limited by the server';
  if (/^http_5\d\d\b/u.test(code)) return 'Server error';
  if (/^http_409\b/u.test(code)) return 'Conflict with the server copy';
  if (/^http_4\d\d\b/u.test(code)) return 'The server rejected the upload';
  return 'Unrecognised sync error';
}

export interface PreviousSyncTracking {
  agentSyncPending: number | null;
  agentSyncPendingSince: Date | null;
  agentSyncLastError: string | null;
  agentSyncErrorSince: Date | null;
  agentDiagnosticsUpdatedAt: Date | null;
}

/** The previous-report columns the heartbeat reads — spread into a Prisma `select`. */
export const SYNC_TRACKING_SELECT = {
  agentSyncPending: true,
  agentSyncPendingSince: true,
  agentSyncLastError: true,
  agentSyncErrorSince: true,
  agentDiagnosticsUpdatedAt: true,
} as const;

/**
 * Server-clock bookkeeping for one diagnostics report: when the queue was
 * first seen non-empty and when the current error was first seen, carried
 * forward only across uninterrupted reports (a gap of more than 15 minutes
 * starts the clocks again, so time spent offline is not counted as stuck —
 * the drain gets its chance once the laptop is back). An empty queue also
 * re-arms the stuck alert.
 */
export function nextSyncTrackingColumns(
  previous: PreviousSyncTracking | null,
  diagnostics: AgentDiagnostics,
  now: Date,
) {
  const pending = Math.min(Math.max(0, diagnostics.syncPending), MAX_STORED_PENDING);
  const lastReport = ms(previous?.agentDiagnosticsUpdatedAt ?? null);
  const prev = previous && lastReport !== null && now.getTime() - lastReport <= SYNC_DIAGNOSTICS_STALE_MS
    ? previous
    : null;
  const pendingSince = pending === 0
    ? null
    : prev && (prev.agentSyncPending ?? 0) > 0 && prev.agentSyncPendingSince
      ? prev.agentSyncPendingSince
      : now;
  const error = diagnostics.syncLastError;
  const errorSince = error === null
    ? null
    : prev && prev.agentSyncLastError === error && prev.agentSyncErrorSince
      ? prev.agentSyncErrorSince
      : now;
  return {
    agentSyncPending: pending,
    agentSyncPendingSince: pendingSince,
    agentSyncErrorSince: errorSince,
    ...(pending === 0 ? { agentSyncAlertedAt: null } : {}),
  };
}
