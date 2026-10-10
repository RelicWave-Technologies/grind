import type { Status } from '../ui';

/**
 * Timo sync health as the API judges it (apps/api/src/agent/syncHealth.ts):
 * is this person's tracked time reaching the server? The verdict is computed
 * server-side; this file only words it for the People table and Overview.
 */

export type SyncStatus = 'HEALTHY' | 'BEHIND' | 'STUCK' | 'UNKNOWN';

export interface SyncHealth {
  status: SyncStatus;
  reason:
    | 'synced'
    | 'pending_recent'
    | 'pending_old'
    | 'pending_very_old'
    | 'error_repeating'
    | 'no_agent'
    | 'no_diagnostics'
    | 'stale_diagnostics';
  lastKnownStatus: Exclude<SyncStatus, 'UNKNOWN'> | null;
  pending: number | null;
  oldestPendingAgeMs: number | null;
  lastError: string | null;
  lastErrorLabel: string | null;
  lastErrorForMs: number | null;
  reportedAt: string | null;
  reportAgeMs: number | null;
  agentVersion: string | null;
  platform: string | null;
  osVersion: string | null;
  arch: string | null;
}

/** The People filter values (`/users?sync=stuck`). */
export const SYNC_FILTERS = ['stuck', 'behind', 'unknown'] as const;
export type SyncFilter = (typeof SYNC_FILTERS)[number];

export function parseSyncFilter(value: unknown): SyncFilter | undefined {
  return typeof value === 'string' && (SYNC_FILTERS as readonly string[]).includes(value)
    ? (value as SyncFilter)
    : undefined;
}

export function matchesSyncFilter(sync: SyncHealth | null, filter: SyncFilter): boolean {
  return sync !== null && sync.status === filter.toUpperCase();
}

const STATUS_TAG: Record<SyncStatus, { label: string; status: Status }> = {
  HEALTHY: { label: 'Synced', status: 'success' },
  BEHIND: { label: 'Behind', status: 'warn' },
  STUCK: { label: 'Stuck', status: 'danger' },
  UNKNOWN: { label: 'Unknown', status: 'neutral' },
};

const PLATFORM_LABEL: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

/** "3m", "2h 05m", "4d" — a duration, not an "ago". */
export function fmtDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'under a minute';
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${String(min % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d`;
}

function fmtCount(n: number): string {
  return n.toLocaleString('en-US');
}

/** The one-line summary under the tag. */
export function syncSummary(sync: SyncHealth): string {
  switch (sync.reason) {
    case 'no_agent':
      return 'No Timo heartbeat yet';
    case 'no_diagnostics':
      return 'Timo too old to report';
    case 'stale_diagnostics':
      return `Last report ${fmtDuration(sync.reportAgeMs)} ago`;
    case 'synced':
      return 'Nothing waiting';
    default: {
      const pending = sync.pending ?? 0;
      return `${fmtCount(pending)} waiting · oldest ${fmtDuration(sync.oldestPendingAgeMs)}`;
    }
  }
}

/** The tag plus a plain-text detail for its tooltip. */
export function syncTag(sync: SyncHealth): { label: string; status: Status; summary: string; title: string } {
  const tag = STATUS_TAG[sync.status];
  const lines: string[] = [];
  if (sync.reason === 'stale_diagnostics') {
    lines.push(
      `Timo has not reported for ${fmtDuration(sync.reportAgeMs)} (offline?).`,
      `Last known: ${sync.lastKnownStatus ? STATUS_TAG[sync.lastKnownStatus].label : 'Unknown'}.`,
    );
  } else if (sync.reason === 'no_agent') {
    lines.push('No Timo heartbeat has arrived for this person.');
  } else if (sync.reason === 'no_diagnostics') {
    lines.push('This Timo version does not report its upload queue. Updating Timo fixes it.');
  } else if (sync.status === 'STUCK') {
    lines.push(sync.reason === 'error_repeating'
      ? `The same upload error has repeated for ${fmtDuration(sync.lastErrorForMs)}.`
      : 'Tracked time has been waiting on the laptop for over 2 hours.');
  } else if (sync.status === 'BEHIND') {
    lines.push('Tracked time has been waiting on the laptop for over 10 minutes.');
  } else {
    lines.push('Tracked time is reaching the server.');
  }
  if (sync.pending !== null) {
    lines.push(`Waiting to upload: ${fmtCount(sync.pending)}`);
    if (sync.pending > 0) lines.push(`Oldest waiting: ${fmtDuration(sync.oldestPendingAgeMs)}`);
  }
  if (sync.lastError) {
    lines.push(`Last error: ${sync.lastErrorLabel ?? 'Unrecognised'} (${sync.lastError})`);
  }
  const device = [
    sync.agentVersion ? `Timo v${sync.agentVersion.replace(/^v/u, '')}` : null,
    sync.platform ? (PLATFORM_LABEL[sync.platform] ?? sync.platform) + (sync.osVersion ? ` ${sync.osVersion}` : '') : null,
    sync.arch,
  ].filter(Boolean);
  if (device.length > 0) lines.push(device.join(' · '));
  if (sync.reportAgeMs !== null && sync.reason !== 'stale_diagnostics') {
    lines.push(`Reported ${fmtDuration(sync.reportAgeMs)} ago`);
  }
  return { label: tag.label, status: tag.status, summary: syncSummary(sync), title: lines.join('\n') };
}
