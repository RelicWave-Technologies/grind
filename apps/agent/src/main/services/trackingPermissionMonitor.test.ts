import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * These exercise macOS-only behaviour. `trackingPermissionMonitor` returns
 * immediately when `process.platform !== 'darwin'`, and `trackingReadiness`
 * builds its deps from `process.platform`, so on a Linux CI runner the code
 * under test never does anything and the assertions fail on the runner's OS
 * rather than on the behaviour. Pin the platform so the test means the same
 * thing everywhere. (This is why agent CI has been red since 19 July.)
 */
const realPlatform = process.platform;
vi.hoisted(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
});
afterAll(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
});


const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  pauseForPermission: vi.fn(),
  inspect: vi.fn(),
  noteScreenHealth: vi.fn(),
  offerResume: vi.fn(),
  broadcast: vi.fn(),
  heartbeat: vi.fn(),
  setActivityRecording: vi.fn(),
  idleState: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('electron', () => ({
  powerMonitor: { getSystemIdleState: mocks.idleState },
}));
vi.mock('./timer', () => ({
  getTimerService: () => ({ status: mocks.status, pauseForPermission: mocks.pauseForPermission }),
}));
// Keep the real pure helpers (isInconclusiveScreenCapture) — only the
// stateful service singleton is replaced.
vi.mock('./trackingReadiness', async (importOriginal) => ({
  ...(await importOriginal() as Record<string, unknown>),
  getTrackingReadinessService: () => ({ inspect: mocks.inspect, noteScreenHealth: mocks.noteScreenHealth }),
}));
vi.mock('./trackingCommands', () => ({ offerPermissionResume: mocks.offerResume }));
vi.mock('./heartbeat', () => ({ sendHeartbeatNow: mocks.heartbeat }));
vi.mock('../broadcast', () => ({ broadcast: mocks.broadcast }));
vi.mock('./capture', () => ({ onScreenHealthChange: () => () => undefined }));
// trackingReadiness pulls probeScreenCapture from './capture/capture', which is
// a DIFFERENT specifier from './capture' above and so is not covered by that
// mock. importOriginal() on trackingReadiness therefore loads the real module,
// which loads sharp — and with the platform pinned to darwin, sharp looks for a
// macOS binary and dies on a Linux runner.
vi.mock('./capture/capture', () => ({ probeScreenCapture: vi.fn() }));
vi.mock('./activity', () => ({
  onActivityCaptureStatusChange: () => () => undefined,
  setActivityRecording: mocks.setActivityRecording,
}));
vi.mock('../logger', () => ({ log: { warn: mocks.warn } }));

import {
  startTrackingPermissionMonitor,
  stopTrackingPermissionMonitor,
} from './trackingPermissionMonitor';

function inspection(ready: boolean) {
  return {
    readiness: {
      ready,
      checkedAt: new Date().toISOString(),
      screenRecording: ready ? 'READY' : 'NEEDS_SETTINGS',
      accessibility: 'READY',
      blockingCapabilities: ready ? [] : ['SCREEN_RECORDING'],
    },
    permissions: {
      screen: { status: ready ? 'granted' : 'denied', health: ready ? 'ok' : 'no-permission', state: ready ? 'ok' : 'needs-settings' },
      accessibility: { trusted: true, ready: true, recording: true, capturing: true, hookRunning: true },
    },
    accessibilityError: null,
  };
}

function blankScreenInspection(screenRecording: 'CHECKING' | 'FAILED') {
  const value = inspection(true);
  return {
    ...value,
    readiness: { ...value.readiness, ready: false, screenRecording, blockingCapabilities: ['SCREEN_RECORDING'] },
    permissions: {
      ...value.permissions,
      screen: { status: 'granted', health: 'empty', state: 'needs-restart' },
    },
  };
}

function hookFailureInspection() {
  const value = inspection(true);
  return {
    ...value,
    readiness: { ...value.readiness, ready: false, accessibility: 'FAILED', blockingCapabilities: ['ACCESSIBILITY'] },
    permissions: {
      ...value.permissions,
      accessibility: { ...value.permissions.accessibility, capturing: false, hookRunning: false },
    },
    accessibilityError: 'native hook denied',
  };
}

describe('tracking permission monitor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T00:00:00.000Z'));
    mocks.status.mockReset();
    mocks.pauseForPermission.mockReset();
    mocks.inspect.mockReset();
    mocks.offerResume.mockReset();
    mocks.broadcast.mockReset();
    mocks.heartbeat.mockReset();
    mocks.setActivityRecording.mockReset();
    mocks.idleState.mockReset().mockReturnValue('active');
    mocks.warn.mockReset();
  });

  afterEach(() => {
    stopTrackingPermissionMonitor();
    vi.useRealTimers();
  });

  it('pauses at the last healthy proof and requires an explicit resume', async () => {
    const running = {
      state: 'RUNNING',
      entryId: 'entry-1',
      revision: 1,
      larkTaskGuid: 'task-1',
      startedAt: Date.now(),
      segmentStartedAt: Date.now(),
      workedMs: 0,
      paused: false,
      pauseReason: null,
    };
    const paused = { ...running, revision: 2, paused: true, pauseReason: 'PERMISSION_REQUIRED' };
    mocks.status.mockReturnValue(running);
    mocks.inspect.mockResolvedValueOnce(inspection(true));
    mocks.pauseForPermission.mockImplementation(async () => {
      mocks.status.mockReturnValue(paused);
      return paused;
    });

    startTrackingPermissionMonitor();
    await vi.advanceTimersByTimeAsync(0);
    const lastHealthyAt = Date.now();

    mocks.inspect.mockResolvedValue(inspection(false));
    await vi.advanceTimersByTimeAsync(2_000);

    // Elapsed since the last healthy proof, not the instant itself: the timer
    // runs on the server-aligned clock and cannot interpret a device reading.
    expect(mocks.pauseForPermission).toHaveBeenCalledWith(Date.now() - lastHealthyAt);
    expect(mocks.setActivityRecording).toHaveBeenCalledWith(false, null);
    expect(mocks.broadcast).toHaveBeenCalledWith('timer:status:push', paused);
    expect(mocks.offerResume).toHaveBeenCalledTimes(1);
  });

  it('does not pause for one transient screen failure when the immediate probe succeeds', async () => {
    const running = {
      state: 'RUNNING', entryId: 'entry-2', revision: 1, larkTaskGuid: null,
      startedAt: Date.now(), segmentStartedAt: Date.now(), workedMs: 0, paused: false, pauseReason: null,
    };
    mocks.status.mockReturnValue(running);
    mocks.inspect.mockResolvedValueOnce(inspection(true));
    startTrackingPermissionMonitor();
    await vi.advanceTimersByTimeAsync(0);

    mocks.inspect
      .mockResolvedValueOnce(inspection(false))
      .mockResolvedValueOnce(inspection(true));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(mocks.pauseForPermission).not.toHaveBeenCalled();
    expect(mocks.offerResume).not.toHaveBeenCalled();
  });

  it('does not pause while readiness is still checking a granted-but-blank screen', async () => {
    const running = {
      state: 'RUNNING', entryId: 'entry-2b', revision: 1, larkTaskGuid: null,
      startedAt: Date.now(), segmentStartedAt: Date.now(), workedMs: 0, paused: false, pauseReason: null,
    };
    mocks.status.mockReturnValue(running);
    mocks.inspect.mockResolvedValueOnce(inspection(true));
    startTrackingPermissionMonitor();
    await vi.advanceTimersByTimeAsync(0);

    // However long it lasts: readiness alone decides when CHECKING is FAILED.
    mocks.inspect.mockResolvedValue(blankScreenInspection('CHECKING'));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mocks.pauseForPermission).not.toHaveBeenCalled();
    expect(mocks.offerResume).not.toHaveBeenCalled();
  });

  it('pauses as soon as readiness calls a granted-but-blank screen FAILED', async () => {
    const running = {
      state: 'RUNNING', entryId: 'entry-2c', revision: 1, larkTaskGuid: null,
      startedAt: Date.now(), segmentStartedAt: Date.now(), workedMs: 0, paused: false, pauseReason: null,
    };
    const paused = { ...running, revision: 2, paused: true, pauseReason: 'PERMISSION_REQUIRED' };
    mocks.status.mockReturnValue(running);
    mocks.inspect.mockResolvedValueOnce(inspection(true));
    mocks.pauseForPermission.mockImplementation(async () => {
      mocks.status.mockReturnValue(paused);
      return paused;
    });
    startTrackingPermissionMonitor();
    await vi.advanceTimersByTimeAsync(0);
    const lastHealthyAt = Date.now();

    mocks.inspect.mockResolvedValue(blankScreenInspection('FAILED'));
    await vi.advanceTimersByTimeAsync(2_000);

    // Elapsed since the last healthy proof, not the instant itself: the timer
    // runs on the server-aligned clock and cannot interpret a device reading.
    expect(mocks.pauseForPermission).toHaveBeenCalledWith(Date.now() - lastHealthyAt);
    expect(mocks.offerResume).toHaveBeenCalledTimes(1);
  });

  it('never pauses for blank captures while the display is asleep or locked', async () => {
    const running = {
      state: 'RUNNING', entryId: 'entry-2d', revision: 1, larkTaskGuid: null,
      startedAt: Date.now(), segmentStartedAt: Date.now(), workedMs: 0, paused: false, pauseReason: null,
    };
    mocks.status.mockReturnValue(running);
    mocks.inspect.mockResolvedValueOnce(inspection(true));
    startTrackingPermissionMonitor();
    await vi.advanceTimersByTimeAsync(0);

    // Display sleep: permission still granted, captures come back empty, and
    // the user has produced no recent input. This must never pause or prompt
    // no matter how long it lasts — well beyond the confirmation window.
    mocks.inspect.mockResolvedValue(blankScreenInspection('FAILED'));
    mocks.idleState.mockReturnValue('idle');
    await vi.advanceTimersByTimeAsync(60_000);

    expect(mocks.pauseForPermission).not.toHaveBeenCalled();
    expect(mocks.offerResume).not.toHaveBeenCalled();
  });

  it('pauses when the native activity hook remains failed beyond its startup allowance', async () => {
    const running = {
      state: 'RUNNING', entryId: 'entry-3', revision: 1, larkTaskGuid: null,
      startedAt: Date.now(), segmentStartedAt: Date.now(), workedMs: 0, paused: false, pauseReason: null,
    };
    const paused = { ...running, paused: true, pauseReason: 'PERMISSION_REQUIRED' };
    mocks.status.mockReturnValue(running);
    mocks.inspect.mockResolvedValueOnce(inspection(true));
    mocks.pauseForPermission.mockImplementation(async () => {
      mocks.status.mockReturnValue(paused);
      return paused;
    });
    startTrackingPermissionMonitor();
    await vi.advanceTimersByTimeAsync(0);

    mocks.inspect.mockResolvedValue(hookFailureInspection());
    await vi.advanceTimersByTimeAsync(4_000);

    expect(mocks.pauseForPermission).toHaveBeenCalledTimes(1);
    expect(mocks.offerResume).toHaveBeenCalledTimes(1);
  });

  it('does not relabel a pause the user made while readiness was being checked', async () => {
    const running = {
      state: 'RUNNING', entryId: 'entry-4', revision: 1, larkTaskGuid: null,
      startedAt: Date.now(), segmentStartedAt: Date.now(), workedMs: 0, paused: false, pauseReason: null,
    };
    const manuallyPaused = { ...running, revision: 2, paused: true, pauseReason: 'MANUAL' };
    mocks.status.mockReturnValue(running);
    mocks.inspect.mockResolvedValueOnce(inspection(true));
    startTrackingPermissionMonitor();
    await vi.advanceTimersByTimeAsync(0);

    // The verdict arrives after the user paused (or idle paused) the timer.
    mocks.inspect.mockImplementation(async () => {
      mocks.status.mockReturnValue(manuallyPaused);
      return inspection(false);
    });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(mocks.inspect).toHaveBeenCalledTimes(3);
    expect(mocks.pauseForPermission).not.toHaveBeenCalled();
    expect(mocks.setActivityRecording).not.toHaveBeenCalled();
    expect(mocks.offerResume).not.toHaveBeenCalled();
  });

  it('does not pause an entry it never inspected', async () => {
    const running = {
      state: 'RUNNING', entryId: 'entry-5', revision: 1, larkTaskGuid: null,
      startedAt: Date.now(), segmentStartedAt: Date.now(), workedMs: 0, paused: false, pauseReason: null,
    };
    mocks.status.mockReturnValue(running);
    mocks.inspect.mockResolvedValueOnce(inspection(true));
    startTrackingPermissionMonitor();
    await vi.advanceTimersByTimeAsync(0);

    mocks.inspect.mockImplementation(async () => {
      mocks.status.mockReturnValue({ ...running, entryId: 'entry-6' });
      return inspection(false);
    });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(mocks.inspect).toHaveBeenCalledTimes(3);
    expect(mocks.pauseForPermission).not.toHaveBeenCalled();
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it('logs, instead of leaking, a pause that throws', async () => {
    const running = {
      state: 'RUNNING', entryId: 'entry-7', revision: 1, larkTaskGuid: null,
      startedAt: Date.now(), segmentStartedAt: Date.now(), workedMs: 0, paused: false, pauseReason: null,
    };
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      mocks.status.mockReturnValue(running);
      mocks.inspect.mockResolvedValue(inspection(false));
      mocks.pauseForPermission.mockRejectedValue(new Error('disk full'));

      startTrackingPermissionMonitor();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2_000);

      expect(mocks.pauseForPermission).toHaveBeenCalled();
      expect(mocks.warn).toHaveBeenCalledWith('tracking permission check failed', { err: 'Error: disk full' });
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
