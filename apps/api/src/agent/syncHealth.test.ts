import { describe, expect, it } from 'vitest';
import {
  classifySyncHealth,
  MAX_STORED_PENDING,
  nextSyncTrackingColumns,
  syncErrorLabel,
  type SyncHealthInput,
} from './syncHealth';

const NOW = new Date('2026-10-05T12:00:00.000Z');
const MIN = 60_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function input(over: Partial<SyncHealthInput> = {}): SyncHealthInput {
  return {
    agentVersion: '0.0.2-beta.39',
    agentPlatform: 'darwin',
    agentLastSeenAt: ago(MIN),
    agentOsVersion: '15.1',
    agentArch: 'arm64',
    agentSyncPending: 0,
    agentSyncOldestPendingAt: null,
    agentSyncLastError: null,
    agentDiagnosticsUpdatedAt: ago(MIN),
    agentSyncPendingSince: null,
    agentSyncErrorSince: null,
    ...over,
  };
}

describe('classifySyncHealth', () => {
  it('is HEALTHY with nothing pending', () => {
    expect(classifySyncHealth(input(), NOW)).toMatchObject({ status: 'HEALTHY', reason: 'synced', pending: 0 });
  });

  it('is HEALTHY while the oldest pending entry is 10 minutes old or less', () => {
    const r = classifySyncHealth(input({ agentSyncPending: 2, agentSyncOldestPendingAt: ago(9 * MIN), agentSyncPendingSince: ago(9 * MIN) }), NOW);
    expect(r).toMatchObject({ status: 'HEALTHY', reason: 'pending_recent', pending: 2, oldestPendingAgeMs: 9 * MIN });
  });

  it('is BEHIND past 10 minutes and STUCK past 2 hours', () => {
    expect(classifySyncHealth(input({ agentSyncPending: 1, agentSyncOldestPendingAt: ago(11 * MIN), agentSyncPendingSince: ago(11 * MIN) }), NOW))
      .toMatchObject({ status: 'BEHIND', reason: 'pending_old' });
    expect(classifySyncHealth(input({ agentSyncPending: 1, agentSyncOldestPendingAt: ago(121 * MIN), agentSyncPendingSince: ago(121 * MIN) }), NOW))
      .toMatchObject({ status: 'STUCK', reason: 'pending_very_old' });
  });

  it('is STUCK when the same error has repeated for more than 30 minutes', () => {
    const r = classifySyncHealth(input({
      agentSyncPending: 1,
      agentSyncOldestPendingAt: ago(40 * MIN),
      agentSyncPendingSince: ago(40 * MIN),
      agentSyncLastError: 'http_400:invalid_segments',
      agentSyncErrorSince: ago(31 * MIN),
    }), NOW);
    expect(r).toMatchObject({
      status: 'STUCK',
      reason: 'error_repeating',
      lastErrorForMs: 31 * MIN,
      lastErrorLabel: 'The server rejected the time segments',
    });
  });

  it('does not call a running timer edited a moment ago stuck (oldest pending is its START)', () => {
    // The live entry started 5h ago and was marked pending by a pause just now.
    const r = classifySyncHealth(input({ agentSyncPending: 1, agentSyncOldestPendingAt: ago(5 * 60 * MIN), agentSyncPendingSince: ago(MIN) }), NOW);
    expect(r).toMatchObject({ status: 'HEALTHY', oldestPendingAgeMs: MIN });
  });

  it('ignores a laptop clock ahead of the server (oldest pending in the future)', () => {
    const r = classifySyncHealth(input({ agentSyncPending: 1, agentSyncOldestPendingAt: new Date(NOW.getTime() + 60 * MIN) }), NOW);
    expect(r.status).toBe('HEALTHY');
    expect(r.oldestPendingAgeMs).toBe(MIN); // as old as the report, never negative
  });

  it('caps a laptop clock far behind by what the server itself observed', () => {
    const r = classifySyncHealth(input({ agentSyncPending: 1, agentSyncOldestPendingAt: ago(30 * 24 * 60 * MIN), agentSyncPendingSince: ago(3 * MIN) }), NOW);
    expect(r).toMatchObject({ status: 'HEALTHY', oldestPendingAgeMs: 3 * MIN });
  });

  it('handles pending with no oldest time and no server observation yet', () => {
    const r = classifySyncHealth(input({ agentSyncPending: 4, agentSyncOldestPendingAt: null, agentSyncPendingSince: null }), NOW);
    expect(r).toMatchObject({ status: 'HEALTHY', pending: 4, oldestPendingAgeMs: MIN });
    const old = classifySyncHealth(input({ agentSyncPending: 4, agentSyncOldestPendingAt: null, agentSyncPendingSince: ago(3 * 60 * MIN) }), NOW);
    expect(old.status).toBe('STUCK');
  });

  it('reports huge pending counts as they are', () => {
    const r = classifySyncHealth(input({ agentSyncPending: MAX_STORED_PENDING, agentSyncPendingSince: ago(MIN) }), NOW);
    expect(r.pending).toBe(MAX_STORED_PENDING);
  });

  it('is UNKNOWN for an agent too old to send diagnostics, keeping its version', () => {
    const r = classifySyncHealth(input({ agentVersion: '0.0.2-beta.20', agentDiagnosticsUpdatedAt: null, agentSyncPending: null }), NOW);
    expect(r).toMatchObject({ status: 'UNKNOWN', reason: 'no_diagnostics', agentVersion: '0.0.2-beta.20', pending: null });
  });

  it('is UNKNOWN with no agent at all', () => {
    const r = classifySyncHealth(input({ agentVersion: null, agentPlatform: null, agentLastSeenAt: null, agentDiagnosticsUpdatedAt: null }), NOW);
    expect(r).toMatchObject({ status: 'UNKNOWN', reason: 'no_agent' });
  });

  it('is UNKNOWN once the last report is over 15 minutes old, with the last-known verdict as of that report', () => {
    const reported = ago(3 * 60 * MIN);
    const r = classifySyncHealth(input({
      agentLastSeenAt: reported,
      agentDiagnosticsUpdatedAt: reported,
      agentSyncPending: 3,
      agentSyncOldestPendingAt: new Date(reported.getTime() - 20 * MIN),
      agentSyncPendingSince: new Date(reported.getTime() - 20 * MIN),
    }), NOW);
    expect(r).toMatchObject({
      status: 'UNKNOWN',
      reason: 'stale_diagnostics',
      lastKnownStatus: 'BEHIND',
      pending: 3,
      oldestPendingAgeMs: 20 * MIN,
      reportAgeMs: 3 * 60 * MIN,
    });
  });
});

describe('nextSyncTrackingColumns', () => {
  const diag = (syncPending: number, syncLastError: string | null = null) => ({
    osVersion: '15.1',
    arch: 'arm64',
    syncPending,
    syncOldestPendingAt: null,
    syncLastError,
  });

  it('starts the pending clock on the first non-empty report and keeps it while reports continue', () => {
    const first = nextSyncTrackingColumns(null, diag(2), NOW);
    expect(first.agentSyncPendingSince).toEqual(NOW);
    const later = new Date(NOW.getTime() + MIN);
    const second = nextSyncTrackingColumns({
      agentSyncPending: 2,
      agentSyncPendingSince: NOW,
      agentSyncLastError: null,
      agentSyncErrorSince: null,
      agentDiagnosticsUpdatedAt: NOW,
    }, diag(5), later);
    expect(second.agentSyncPendingSince).toEqual(NOW);
  });

  it('clears the clocks and re-arms the alert when the queue empties', () => {
    const r = nextSyncTrackingColumns({
      agentSyncPending: 2,
      agentSyncPendingSince: ago(60 * MIN),
      agentSyncLastError: 'http_409:timer_conflict',
      agentSyncErrorSince: ago(60 * MIN),
      agentDiagnosticsUpdatedAt: ago(MIN),
    }, diag(0), NOW);
    expect(r).toEqual({ agentSyncPending: 0, agentSyncPendingSince: null, agentSyncErrorSince: null, agentSyncAlertedAt: null });
  });

  it('restarts the clocks after a reporting gap (offline time is not stuck time)', () => {
    const r = nextSyncTrackingColumns({
      agentSyncPending: 3,
      agentSyncPendingSince: ago(2 * 24 * 60 * MIN),
      agentSyncLastError: 'TypeError:fetch failed',
      agentSyncErrorSince: ago(2 * 24 * 60 * MIN),
      agentDiagnosticsUpdatedAt: ago(16 * MIN),
    }, diag(3, 'TypeError:fetch failed'), NOW);
    expect(r.agentSyncPendingSince).toEqual(NOW);
    expect(r.agentSyncErrorSince).toEqual(NOW);
    expect(r).not.toHaveProperty('agentSyncAlertedAt');
  });

  it('keeps the error clock only while the error stays the same', () => {
    const prev = {
      agentSyncPending: 1,
      agentSyncPendingSince: ago(20 * MIN),
      agentSyncLastError: 'http_409:timer_conflict',
      agentSyncErrorSince: ago(20 * MIN),
      agentDiagnosticsUpdatedAt: ago(MIN),
    };
    expect(nextSyncTrackingColumns(prev, diag(1, 'http_409:timer_conflict'), NOW).agentSyncErrorSince).toEqual(ago(20 * MIN));
    expect(nextSyncTrackingColumns(prev, diag(1, 'http_400:invalid_segments'), NOW).agentSyncErrorSince).toEqual(NOW);
    expect(nextSyncTrackingColumns(prev, diag(1, null), NOW).agentSyncErrorSince).toBeNull();
  });

  it('caps a pending count the INTEGER column cannot hold', () => {
    expect(nextSyncTrackingColumns(null, diag(1e15), NOW).agentSyncPending).toBe(MAX_STORED_PENDING);
  });
});

describe('syncErrorLabel', () => {
  it('names the common codes', () => {
    expect(syncErrorLabel('http_409:timer_conflict')).toBe('Another device holds the running timer');
    expect(syncErrorLabel('http_400:invalid_segments')).toBe('The server rejected the time segments');
    expect(syncErrorLabel('TypeError:fetch failed')).toBe('Network unreachable');
    expect(syncErrorLabel('Error:getaddrinfo ENOTFOUND api.example.com')).toBe('Network unreachable');
    expect(syncErrorLabel('Error:unable to verify the first certificate')).toMatch(/TLS/);
    expect(syncErrorLabel('Error:self signed certificate in certificate chain')).toMatch(/TLS/);
    expect(syncErrorLabel('AbortError:This operation was aborted')).toBe('The upload timed out');
    expect(syncErrorLabel('UnauthorizedError:refresh_failed')).toMatch(/Signed out/);
    expect(syncErrorLabel('http_503')).toBe('Server error');
    expect(syncErrorLabel('http_409:something_new')).toBe('Conflict with the server copy');
    expect(syncErrorLabel('unacknowledged_receipt')).toMatch(/did not confirm/);
    expect(syncErrorLabel('Weird:thing')).toBe('Unrecognised sync error');
    expect(syncErrorLabel(null)).toBeNull();
  });
});
