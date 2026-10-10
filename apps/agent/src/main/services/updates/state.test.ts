import { describe, expect, it } from 'vitest';
import {
  applyUpdateEvent,
  canInstallUpdate,
  describeUpdateError,
  effectiveUpdateChannel,
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

  it('puts an abandoned install back to ready', () => {
    const ready = applyUpdateEvent(base(), { type: 'downloaded', version: '1.0.1', canInstallNow: true, at: 30 });
    const installing = applyUpdateEvent(ready, { type: 'installing', at: 40 });
    const aborted = applyUpdateEvent(installing, { type: 'install-aborted', canInstallNow: false });

    expect(aborted.phase).toBe('ready');
    expect(aborted.availableVersion).toBe('1.0.1');
    expect(aborted.canInstallNow).toBe(false);
    // Only an install in progress can be abandoned.
    expect(applyUpdateEvent(ready, { type: 'install-aborted', canInstallNow: true })).toBe(ready);
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

describe('effective update channel', () => {
  it('keeps the baked channel for stable versions and beta builds', () => {
    expect(effectiveUpdateChannel('latest', '1.0.0')).toBe('latest');
    expect(effectiveUpdateChannel('beta', '1.0.0')).toBe('beta');
    expect(effectiveUpdateChannel('beta', '0.0.2-beta.38')).toBe('beta');
  });

  it('moves a prerelease build mis-baked as latest onto beta', () => {
    // On "latest" electron-updater only asks for the newest non-prerelease
    // release, and every Timo release is a beta: it would never update.
    expect(effectiveUpdateChannel('latest', '0.0.2-beta.38')).toBe('beta');
  });

  it('leaves other prerelease names and unparseable versions alone', () => {
    expect(effectiveUpdateChannel('latest', '1.0.0-rc.1')).toBe('latest');
    expect(effectiveUpdateChannel('latest', 'dev')).toBe('latest');
  });
});

describe('update error description', () => {
  it('leads with the electron-updater code', () => {
    const err = Object.assign(new Error('Cannot find beta.yml in the latest release artifacts\nstack...'), {
      code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
    });
    expect(describeUpdateError(err)).toBe(
      'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND: Cannot find beta.yml in the latest release artifacts',
    );
  });

  it('does not repeat a code the message already carries', () => {
    const err = Object.assign(new Error('net::ERR_INTERNET_DISCONNECTED'), { code: 'ERR_INTERNET_DISCONNECTED' });
    expect(describeUpdateError(err)).toBe('net::ERR_INTERNET_DISCONNECTED');
  });

  it('handles non-errors and empty messages', () => {
    expect(describeUpdateError('offline')).toBe('offline');
    expect(describeUpdateError(new Error(''))).toBe('unknown error');
  });

  it('fits the 200-character diagnostics column', () => {
    const line = describeUpdateError(Object.assign(new Error('x'.repeat(500)), { code: 'EACCES' }));
    expect(line.length).toBe(200);
    expect(line.startsWith('EACCES: xxx')).toBe(true);
  });
});
