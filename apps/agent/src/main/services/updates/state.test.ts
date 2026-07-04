import { describe, expect, it } from 'vitest';
import {
  applyUpdateEvent,
  canInstallUpdate,
  initialUpdateStatus,
  isVersionNewer,
  nextRetryDelayMs,
} from './state';

const base = () =>
  initialUpdateStatus({
    enabled: true,
    currentVersion: '1.0.0',
    channel: 'latest',
    canInstallNow: true,
  });

describe('update state transitions', () => {
  it('moves checking to not available for a manual up-to-date check', () => {
    const checking = applyUpdateEvent(base(), { type: 'checking', manual: true, at: 10 });
    const done = applyUpdateEvent(checking, { type: 'not-available', manual: true, at: 20 });

    expect(done.phase).toBe('not-available');
    expect(done.manual).toBe(true);
    expect(done.checkedAt).toBe(20);
    expect(done.error).toBeNull();
  });

  it('moves available through download progress to ready', () => {
    let s = applyUpdateEvent(base(), { type: 'checking', manual: false, at: 10 });
    s = applyUpdateEvent(s, { type: 'available', version: '1.0.1' });
    expect(s.phase).toBe('available');
    expect(s.availableVersion).toBe('1.0.1');

    s = applyUpdateEvent(s, { type: 'download-progress', percent: 47.4 });
    expect(s.phase).toBe('downloading');
    expect(s.percent).toBe(47.4);

    s = applyUpdateEvent(s, { type: 'downloaded', version: '1.0.1', canInstallNow: false, at: 30 });
    expect(s.phase).toBe('ready');
    expect(s.percent).toBe(100);
    expect(s.canInstallNow).toBe(false);
  });

  it('moves ready to installing when the user restarts for an update', () => {
    const ready = applyUpdateEvent(base(), { type: 'downloaded', version: '1.0.1', canInstallNow: true, at: 30 });
    const installing = applyUpdateEvent(ready, { type: 'installing', at: 40 });

    expect(installing.phase).toBe('installing');
    expect(installing.manual).toBe(true);
    expect(installing.percent).toBe(100);
    expect(installing.checkedAt).toBe(40);
    expect(installing.error).toBeNull();
  });

  it('uses the requested automatic error backoff', () => {
    expect(nextRetryDelayMs(1)).toBe(15 * 60_000);
    expect(nextRetryDelayMs(2)).toBe(60 * 60_000);
    expect(nextRetryDelayMs(3)).toBeNull();
  });

  it('only allows install when no timer is open', () => {
    expect(canInstallUpdate({ state: 'IDLE' })).toBe(true);
    expect(canInstallUpdate({ state: 'RUNNING', paused: false })).toBe(false);
    expect(canInstallUpdate({ state: 'RUNNING', paused: true })).toBe(false);
  });

  it('compares beta prerelease numbers numerically', () => {
    expect(isVersionNewer('0.0.2-beta.18', '0.0.2-beta.19')).toBe(true);
    expect(isVersionNewer('0.0.2-beta.19', '0.0.2-beta.11')).toBe(false);
    expect(isVersionNewer('0.0.2-beta.19', '0.0.2-beta.19')).toBe(false);
    expect(isVersionNewer('0.0.2-beta.19', '0.0.3-beta.1')).toBe(true);
  });

  it('ignores stale downloaded updates below the current app version', () => {
    const ready = applyUpdateEvent(
      initialUpdateStatus({
        enabled: true,
        currentVersion: '0.0.2-beta.19',
        channel: 'beta',
      }),
      { type: 'downloaded', version: '0.0.2-beta.11', canInstallNow: true, at: 30 },
    );

    expect(ready.phase).toBe('not-available');
    expect(ready.availableVersion).toBeNull();
    expect(ready.readyAt).toBeNull();
  });
});
