import { describe, expect, it, vi } from 'vitest';

vi.mock('../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
import type { ActivityCaptureStatus } from './activity';
import {
  createTrackingReadinessService,
  isInconclusiveScreenCapture,
  permissionRelaunchReason,
  TrackingBlockedError,
} from './trackingReadiness';
import type { CaptureHealth, ScreenStatus } from './permissions';
import type { PermissionRelaunch } from './preferences';

const T0 = 1_700_000_000_000;

function accessibility(patch: Partial<ActivityCaptureStatus> = {}): ActivityCaptureStatus {
  return {
    trusted: true,
    ready: true,
    recording: false,
    capturing: false,
    hookRunning: false,
    lastHookError: null,
    ...patch,
  };
}

function setup(opts: {
  platform?: NodeJS.Platform;
  screenStatus?: ScreenStatus;
  screenHealth?: CaptureHealth;
  accessibility?: ActivityCaptureStatus;
  probeHealth?: CaptureHealth;
  relaunch?: PermissionRelaunch;
} = {}) {
  const clock = { now: T0 };
  const probeScreen = vi.fn().mockResolvedValue(opts.probeHealth ?? 'ok');
  const startActivityCapture = vi.fn();
  const accessibilityStatus = vi.fn(() => opts.accessibility ?? accessibility());
  const service = createTrackingReadinessService({
    platform: opts.platform ?? 'darwin',
    now: () => clock.now,
    screenStatus: () => opts.screenStatus ?? 'granted',
    screenHealth: () => opts.screenHealth ?? 'unknown',
    accessibilityStatus,
    startActivityCapture,
    probeScreen,
    lastPermissionRelaunch: () => opts.relaunch ?? null,
  });
  return { service, probeScreen, startActivityCapture, accessibilityStatus, clock };
}

describe('TrackingReadinessService', () => {
  it('treats macOS capabilities as ready only after a real screen probe', async () => {
    const { service, probeScreen } = setup();

    const result = await service.inspect({ verifyScreen: true });

    expect(probeScreen).toHaveBeenCalledTimes(1);
    expect(result.readiness).toMatchObject({
      ready: true,
      screenRecording: 'READY',
      accessibility: 'READY',
      blockingCapabilities: [],
    });
  });

  it('does not trigger the native screen prompt during a passive status check', async () => {
    const { service, probeScreen } = setup({ screenStatus: 'not-determined' });

    const result = await service.inspect({ verifyScreen: true });

    expect(probeScreen).not.toHaveBeenCalled();
    expect(result.readiness).toMatchObject({
      ready: false,
      screenRecording: 'NEEDS_GRANT',
      blockingCapabilities: ['SCREEN_RECORDING'],
    });
  });

  it('maps denied screen access to System Settings', async () => {
    const denied = setup({ screenStatus: 'denied', screenHealth: 'no-permission' });

    expect((await denied.service.inspect()).readiness.screenRecording).toBe('NEEDS_SETTINGS');
  });

  it('never asks for a restart when a granted screen probes blank', async () => {
    // getMediaAccessStatus('screen') === 'granted' means the grant is already
    // effective in this process. Slow Macs return blank frames from the first
    // captures of a fresh process; a restart reproduces that, it cannot fix it.
    for (const probeHealth of ['empty', 'error'] as const) {
      const { service } = setup({ probeHealth });

      const result = await service.inspect({ verifyScreen: true });

      expect(result.readiness.screenRecording).toBe('CHECKING');
      expect(result.readiness.blockingCapabilities).toEqual(['SCREEN_RECORDING']);
      expect(result.permissions.screen.health).toBe(probeHealth);
    }
  });

  it('re-probes a blank screen no more than every five seconds', async () => {
    const { service, probeScreen, clock } = setup({ probeHealth: 'empty' });

    await service.inspect({ verifyScreen: true });
    clock.now = T0 + 4_999;
    const throttled = await service.inspect({ verifyScreen: true });
    expect(probeScreen).toHaveBeenCalledTimes(1);
    // The skipped inspect still reports the blank reading, not 'unknown'.
    expect(throttled.permissions.screen.health).toBe('empty');

    probeScreen.mockResolvedValue('ok');
    clock.now = T0 + 5_000;
    const recovered = await service.inspect({ verifyScreen: true });

    expect(probeScreen).toHaveBeenCalledTimes(2);
    expect(recovered.readiness).toMatchObject({ ready: true, screenRecording: 'READY' });
  });

  it('reports a screen that stays blank as FAILED, still not as a restart', async () => {
    const { service, clock } = setup({ probeHealth: 'empty' });

    const states = [];
    for (let i = 0; i < 3; i += 1) {
      clock.now = T0 + i * 5_000;
      states.push((await service.inspect({ verifyScreen: true })).readiness.screenRecording);
    }

    expect(states).toEqual(['CHECKING', 'CHECKING', 'FAILED']);
  });

  it('lets an explicit recheck probe straight away', async () => {
    const { service, probeScreen } = setup({ probeHealth: 'empty' });

    await service.inspect({ verifyScreen: true });
    probeScreen.mockResolvedValue('ok');
    const result = await service.recheck();

    expect(probeScreen).toHaveBeenCalledTimes(2);
    expect(result.readiness.screenRecording).toBe('READY');
  });

  it('re-verifies on Start even inside the re-probe spacing', async () => {
    const { service, probeScreen } = setup({ probeHealth: 'empty' });
    await service.inspect({ verifyScreen: true });
    probeScreen.mockResolvedValue('ok');

    await expect(service.assertCanAccrue()).resolves.toBeUndefined();
    expect(probeScreen).toHaveBeenCalledTimes(2);
  });

  it('requires accessibility trust and an initialized native activity service', async () => {
    const untrusted = setup({ accessibility: accessibility({ trusted: false }) });
    const restart = setup({ accessibility: accessibility({ ready: false }) });
    const failed = setup({ accessibility: accessibility({ lastHookError: 'native hook denied' }) });

    expect((await untrusted.service.inspect({ verifyScreen: true })).readiness.accessibility).toBe('NEEDS_GRANT');
    expect((await restart.service.inspect({ verifyScreen: true })).readiness.accessibility).toBe('NEEDS_RESTART');
    expect((await failed.service.inspect({ verifyScreen: true })).readiness.accessibility).toBe('FAILED');
    expect(untrusted.startActivityCapture).not.toHaveBeenCalled();
  });

  it('starts activity capture in-process once accessibility is trusted, instead of asking for a restart', async () => {
    const { service, startActivityCapture, accessibilityStatus } = setup();
    accessibilityStatus
      .mockReturnValueOnce(accessibility({ ready: false }))
      .mockReturnValue(accessibility({ ready: true }));

    const result = await service.inspect();

    expect(startActivityCapture).toHaveBeenCalledOnce();
    expect(result.readiness.accessibility).toBe('READY');
  });

  it('marks a verdict that survived a restart within two minutes', async () => {
    const before = setup({ accessibility: accessibility({ ready: false }) });
    const verdict = (await before.service.inspect({ verifyScreen: true })).readiness;
    const reason = permissionRelaunchReason(verdict);
    expect(reason).toBe('ACCESSIBILITY:NEEDS_RESTART');

    const soon = setup({ accessibility: accessibility({ ready: false }), relaunch: { reason, at: T0 - 119_000 } });
    expect((await soon.service.inspect({ verifyScreen: true })).readiness.restartDidNotHelp).toEqual(['ACCESSIBILITY']);

    const later = setup({ accessibility: accessibility({ ready: false }), relaunch: { reason, at: T0 - 120_000 } });
    expect((await later.service.inspect({ verifyScreen: true })).readiness.restartDidNotHelp).toEqual([]);

    // A restart for a different verdict says nothing about this one.
    const other = setup({
      accessibility: accessibility({ ready: false }),
      relaunch: { reason: 'ACCESSIBILITY:NEEDS_GRANT', at: T0 - 10_000 },
    });
    expect((await other.service.inspect({ verifyScreen: true })).readiness.restartDidNotHelp).toEqual([]);
  });

  it('blocks accrual with a typed, serializable readiness payload', async () => {
    const { service } = setup({ screenStatus: 'denied' });

    await expect(service.assertCanAccrue()).rejects.toBeInstanceOf(TrackingBlockedError);
    await expect(service.assertCanAccrue()).rejects.toMatchObject({
      code: 'TRACKING_PERMISSIONS_REQUIRED',
      readiness: { blockingCapabilities: ['SCREEN_RECORDING'] },
    });
  });

  it('marks macOS-only capabilities not required on Windows without probing', async () => {
    const { service, probeScreen } = setup({
      platform: 'win32',
      screenStatus: 'denied',
      accessibility: accessibility({ trusted: false, ready: false }),
    });

    const result = await service.inspect({ verifyScreen: true });

    expect(probeScreen).not.toHaveBeenCalled();
    expect(result.readiness).toEqual({
      ready: true,
      checkedAt: new Date(1_700_000_000_000).toISOString(),
      screenRecording: 'NOT_REQUIRED',
      accessibility: 'NOT_REQUIRED',
      blockingCapabilities: [],
    });
  });
});

describe('isInconclusiveScreenCapture', () => {
  it('holds the verdict for empty captures while the user is not active', async () => {
    const { service } = setup({ screenHealth: 'empty', probeHealth: 'empty' });
    const inspection = await service.inspect({ verifyScreen: true });

    expect(inspection.readiness.blockingCapabilities).toEqual(['SCREEN_RECORDING']);
    expect(isInconclusiveScreenCapture(inspection, 'idle')).toBe(true);
    expect(isInconclusiveScreenCapture(inspection, 'locked')).toBe(true);
    expect(isInconclusiveScreenCapture(inspection, 'unknown')).toBe(true);
  });

  it('treats empty captures during active use as a real failure', async () => {
    const { service } = setup({ screenHealth: 'empty', probeHealth: 'empty' });
    const inspection = await service.inspect({ verifyScreen: true });

    expect(isInconclusiveScreenCapture(inspection, 'active')).toBe(false);
  });

  it('never masks a revoked permission or an accessibility failure', async () => {
    const denied = setup({ screenStatus: 'denied' });
    expect(isInconclusiveScreenCapture(await denied.service.inspect(), 'idle')).toBe(false);

    const twoBlockers = setup({
      screenHealth: 'empty',
      probeHealth: 'empty',
      accessibility: accessibility({ trusted: false }),
    });
    expect(isInconclusiveScreenCapture(await twoBlockers.service.inspect({ verifyScreen: true }), 'idle')).toBe(false);
  });
});
