import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  pauseForPermission: vi.fn(),
  inspect: vi.fn(),
  noteScreenHealth: vi.fn(),
  offerResume: vi.fn(),
  broadcast: vi.fn(),
  heartbeat: vi.fn(),
  setActivityRecording: vi.fn(),
}));

vi.mock('./timer', () => ({
  getTimerService: () => ({ status: mocks.status, pauseForPermission: mocks.pauseForPermission }),
}));
vi.mock('./trackingReadiness', () => ({
  getTrackingReadinessService: () => ({ inspect: mocks.inspect, noteScreenHealth: mocks.noteScreenHealth }),
}));
vi.mock('./trackingCommands', () => ({ offerPermissionResume: mocks.offerResume }));
vi.mock('./heartbeat', () => ({ sendHeartbeatNow: mocks.heartbeat }));
vi.mock('../broadcast', () => ({ broadcast: mocks.broadcast }));
vi.mock('./capture', () => ({ onScreenHealthChange: () => () => undefined }));
vi.mock('./activity', () => ({
  onActivityCaptureStatusChange: () => () => undefined,
  setActivityRecording: mocks.setActivityRecording,
}));
vi.mock('../logger', () => ({ log: { warn: vi.fn() } }));

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

    expect(mocks.pauseForPermission).toHaveBeenCalledWith(lastHealthyAt);
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
});
