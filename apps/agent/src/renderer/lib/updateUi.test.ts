import { describe, expect, it } from 'vitest';
import type { UpdateStatus } from './agent.d';
import { settingsUpdateSubtitle, updateAction, updateReadyBannerText } from './updateUi';

function status(patch: Partial<UpdateStatus>): UpdateStatus {
  return {
    phase: 'idle',
    enabled: true,
    currentVersion: '1.0.0',
    channel: 'latest',
    availableVersion: null,
    percent: null,
    error: null,
    checkedAt: null,
    readyAt: null,
    manual: false,
    canInstallNow: true,
    ...patch,
  };
}

describe('update UI decisions', () => {
  it('does not call unloaded update status disabled', () => {
    expect(settingsUpdateSubtitle()).toBe('Checking update status…');
  });

  it('does not expose restart before the update is ready', () => {
    expect(updateAction(status({ phase: 'available', availableVersion: '1.0.1' })).kind).toBe('check');
    expect(updateAction(status({ phase: 'downloading', percent: 40 })).disabled).toBe(true);
    expect(updateReadyBannerText(status({ phase: 'downloading', percent: 40 }))).toBeNull();
  });

  it('shows passive copy while tracking or paused', () => {
    const s = status({ phase: 'ready', availableVersion: '1.0.1', canInstallNow: false });
    expect(updateAction(s).kind).toBe('none');
    expect(settingsUpdateSubtitle(s)).toBe('Update ready — restart after you stop tracking.');
    expect(updateReadyBannerText(s)).toBe('Update ready — restart after you stop tracking.');
  });

  it('promotes to restart after the timer stops', () => {
    const s = status({ phase: 'ready', availableVersion: '1.0.1', canInstallNow: true });
    expect(updateAction(s)).toEqual({ kind: 'restart', label: 'Restart to update', disabled: false });
    expect(updateReadyBannerText(s)).toBe('Timo 1.0.1 is ready.');
  });

  it('shows a non-clickable restarting state during install', () => {
    const s = status({ phase: 'installing', availableVersion: '1.0.1', percent: 100 });
    expect(updateAction(s)).toEqual({ kind: 'restart', label: 'Restarting…', disabled: true });
    expect(settingsUpdateSubtitle(s)).toBe('Restarting Timo…');
    expect(updateReadyBannerText(s)).toBe('Restarting Timo…');
  });

  it('surfaces manual up-to-date and manual error states inline', () => {
    expect(settingsUpdateSubtitle(status({ phase: 'not-available', manual: true }))).toBe('You’re up to date');
    expect(settingsUpdateSubtitle(status({ phase: 'error', manual: true, error: 'offline' }))).toBe('Couldn’t check for updates');
  });
});
