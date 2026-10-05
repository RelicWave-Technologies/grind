import { describe, expect, it } from 'vitest';
import { fmtDuration, matchesSyncFilter, parseSyncFilter, syncTag, type SyncHealth } from './syncHealth';

const MIN = 60_000;

function sync(over: Partial<SyncHealth> = {}): SyncHealth {
  return {
    status: 'HEALTHY',
    reason: 'synced',
    lastKnownStatus: null,
    pending: 0,
    oldestPendingAgeMs: null,
    lastError: null,
    lastErrorLabel: null,
    lastErrorForMs: null,
    reportedAt: '2026-10-05T12:00:00.000Z',
    reportAgeMs: MIN,
    agentVersion: '0.0.2-beta.39',
    platform: 'darwin',
    osVersion: '15.1',
    arch: 'arm64',
    ...over,
  };
}

describe('syncTag', () => {
  it('words a stuck person with the error, counts and device', () => {
    const tag = syncTag(sync({
      status: 'STUCK',
      reason: 'error_repeating',
      pending: 12_345,
      oldestPendingAgeMs: 3 * 60 * MIN + 5 * MIN,
      lastError: 'http_409:timer_conflict',
      lastErrorLabel: 'Another device holds the running timer',
      lastErrorForMs: 45 * MIN,
    }));
    expect(tag).toMatchObject({ label: 'Stuck', status: 'danger', summary: '12,345 waiting · oldest 3h 05m' });
    expect(tag.title).toContain('The same upload error has repeated for 45m.');
    expect(tag.title).toContain('Last error: Another device holds the running timer (http_409:timer_conflict)');
    expect(tag.title).toContain('Timo v0.0.2-beta.39 · macOS 15.1 · arm64');
  });

  it('shows the last-known verdict and its age for an offline person', () => {
    const tag = syncTag(sync({ status: 'UNKNOWN', reason: 'stale_diagnostics', lastKnownStatus: 'BEHIND', pending: 2, reportAgeMs: 2 * 24 * 60 * MIN }));
    expect(tag).toMatchObject({ label: 'Unknown', status: 'neutral', summary: 'Last report 2d ago' });
    expect(tag.title).toContain('Last known: Behind.');
  });

  it('explains an agent too old to report', () => {
    const tag = syncTag(sync({ status: 'UNKNOWN', reason: 'no_diagnostics', pending: null, reportAgeMs: null, reportedAt: null }));
    expect(tag.summary).toBe('Timo too old to report');
    expect(tag.title).toContain('Updating Timo fixes it.');
    expect(tag.title).not.toContain('Waiting to upload');
  });

  it('reads healthy as Synced', () => {
    expect(syncTag(sync())).toMatchObject({ label: 'Synced', status: 'success', summary: 'Nothing waiting' });
  });
});

describe('sync filter', () => {
  it('parses only known values', () => {
    expect(parseSyncFilter('stuck')).toBe('stuck');
    expect(parseSyncFilter('STUCK')).toBeUndefined();
    expect(parseSyncFilter(3)).toBeUndefined();
  });

  it('matches by status and never matches a hidden verdict', () => {
    expect(matchesSyncFilter(sync({ status: 'STUCK' }), 'stuck')).toBe(true);
    expect(matchesSyncFilter(sync({ status: 'BEHIND' }), 'stuck')).toBe(false);
    expect(matchesSyncFilter(null, 'stuck')).toBe(false);
  });
});

describe('fmtDuration', () => {
  it('formats short and long spans', () => {
    expect(fmtDuration(30_000)).toBe('under a minute');
    expect(fmtDuration(9 * MIN)).toBe('9m');
    expect(fmtDuration(125 * MIN)).toBe('2h 05m');
    expect(fmtDuration(3 * 24 * 60 * MIN)).toBe('3d');
    expect(fmtDuration(null)).toBe('—');
    expect(fmtDuration(-1)).toBe('—');
  });
});
