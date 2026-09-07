import { describe, expect, it, vi } from 'vitest';

vi.mock('../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
import type { ActivityCaptureStatus } from './activity';
import {
  createTrackingReadinessService,
  isInconclusiveScreenCapture,
  TrackingBlockedError,
} from './trackingReadiness';
import type { CaptureHealth, ScreenStatus } from './permissions';

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
  /** A previous launch already told the user to relaunch for screen recording. */
  restartAlreadyAdvised?: boolean;
} = {}) {
  const probeScreen = vi.fn().mockResolvedValue(opts.probeHealth ?? 'ok');
  const noteRestartAdvice = vi.fn();
  const service = createTrackingReadinessService({
    platform: opts.platform ?? 'darwin',
    now: () => 1_700_000_000_000,
    screenStatus: () => opts.screenStatus ?? 'granted',
    screenHealth: () => opts.screenHealth ?? 'unknown',
    accessibilityStatus: () => opts.accessibility ?? accessibility(),
    probeScreen,
    restartAlreadyAdvised: () => opts.restartAlreadyAdvised ?? false,
    noteRestartAdvice,
  });
  return { service, probeScreen, noteRestartAdvice };
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

  it('maps denied screen access to System Settings and a failed effective grant to restart', async () => {
    const denied = setup({ screenStatus: 'denied', screenHealth: 'no-permission' });
    const ineffective = setup({ screenStatus: 'granted', screenHealth: 'error', probeHealth: 'error' });

    expect((await denied.service.inspect()).readiness.screenRecording).toBe('NEEDS_SETTINGS');
    expect((await ineffective.service.inspect({ verifyScreen: true })).readiness.screenRecording).toBe('NEEDS_RESTART');
  });

  it('requires accessibility trust and an initialized native activity service', async () => {
    const untrusted = setup({ accessibility: accessibility({ trusted: false }) });
    const restart = setup({ accessibility: accessibility({ ready: false }) });
    const failed = setup({ accessibility: accessibility({ lastHookError: 'native hook denied' }) });

    expect((await untrusted.service.inspect({ verifyScreen: true })).readiness.accessibility).toBe('NEEDS_GRANT');
    expect((await restart.service.inspect({ verifyScreen: true })).readiness.accessibility).toBe('NEEDS_RESTART');
    expect((await failed.service.inspect({ verifyScreen: true })).readiness.accessibility).toBe('FAILED');
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

/**
 * The relaunch loop from 2026-09-07: five boots in two minutes, each one
 * reporting screen recording as granted, capturing nothing, and telling the
 * user to restart. Restarting was never going to help — the grant itself was
 * stale — so the second time round the advice has to change.
 */
describe('stale screen grant', () => {
  const BLANK = { screenStatus: 'granted' as const, screenHealth: 'empty' as const, probeHealth: 'empty' as const };

  it('asks for a restart the first time capture comes back blank', async () => {
    const { service } = setup(BLANK);

    const { readiness } = await service.inspect({ verifyScreen: true });

    expect(readiness.screenRecording).toBe('NEEDS_RESTART');
  });

  it('remembers that it advised a restart, so the next launch can judge it', async () => {
    const { service, noteRestartAdvice } = setup(BLANK);

    await service.inspect({ verifyScreen: true });

    expect(noteRestartAdvice).toHaveBeenCalledWith(1_700_000_000_000);
  });

  it('stops asking for a restart once one has already been tried', async () => {
    const { service } = setup({ ...BLANK, restartAlreadyAdvised: true });

    const { readiness } = await service.inspect({ verifyScreen: true });

    expect(readiness.screenRecording).toBe('NEEDS_REGRANT');
  });

  it('does not escalate its own advice within a single launch', async () => {
    // The marker is written on the first inspection. Re-reading it on the
    // second — thirty seconds later, no relaunch in between — would jump
    // straight to "re-grant" without the restart ever being tried.
    const { service } = setup(BLANK);

    await service.inspect({ verifyScreen: true });
    const { readiness } = await service.inspect({ verifyScreen: true });

    expect(readiness.screenRecording).toBe('NEEDS_RESTART');
  });

  it('clears the marker once capture works, so a later failure starts over', async () => {
    const { service, noteRestartAdvice } = setup({
      screenStatus: 'granted',
      screenHealth: 'ok',
      restartAlreadyAdvised: true,
    });

    const { readiness } = await service.inspect({ verifyScreen: true });

    expect(readiness.screenRecording).toBe('READY');
    expect(noteRestartAdvice).toHaveBeenCalledWith(null);
  });

  it('still asks for the grant when macOS says it was never given', async () => {
    // An escalation must not swallow the ordinary first-run case.
    const { service } = setup({ screenStatus: 'not-determined', restartAlreadyAdvised: true });

    const { readiness } = await service.inspect({ verifyScreen: true });

    expect(readiness.screenRecording).toBe('NEEDS_GRANT');
  });
});
