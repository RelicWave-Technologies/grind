import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityState } from '../../shared/tracking';

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  recheck: vi.fn(),
  requestPermission: vi.fn(),
  clearTimerPrompts: vi.fn(),
  blocked: false,
  timer: {
    start: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    status: vi.fn(),
  },
}));

vi.mock('../broadcast', () => ({ broadcast: vi.fn() }));
vi.mock('./heartbeat', () => ({ sendHeartbeatNow: vi.fn() }));
vi.mock('./preferences', () => ({ rememberLastLarkTask: vi.fn() }));
vi.mock('./timer', () => ({ getTimerService: () => mocks.timer }));
vi.mock('./trackingAttention', () => ({
  getTrackingAttentionCoordinator: () => ({
    requestPermission: mocks.requestPermission,
    isPermissionActive: () => false,
    clear: vi.fn(),
    clearTimerPrompts: mocks.clearTimerPrompts,
  }),
}));
vi.mock('./trackingReadiness', () => ({
  isTrackingBlockedError: () => mocks.blocked,
  getTrackingReadinessService: () => ({ inspect: mocks.inspect, recheck: mocks.recheck }),
}));

import {
  offerPermissionSetupOnStartup,
  pauseTracking,
  resetPermissionSetupOffer,
  resumeTracking,
  startTracking,
  stopTracking,
} from './trackingCommands';

function verdict(screenRecording: CapabilityState) {
  const ready = screenRecording === 'READY';
  return { readiness: { ready, screenRecording } };
}

describe('startup permission offer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.inspect.mockReset().mockResolvedValue(verdict('NEEDS_GRANT'));
    mocks.recheck.mockReset();
    mocks.requestPermission.mockReset();
    resetPermissionSetupOffer();
  });
  afterEach(() => vi.useRealTimers());

  it('offers setup right away on a manual launch', async () => {
    await offerPermissionSetupOnStartup();

    expect(mocks.requestPermission).toHaveBeenCalledWith('SETUP');
  });

  it('waits out the login rush before the first probe on a login launch', async () => {
    const offer = offerPermissionSetupOnStartup({ openedAtLogin: true });

    await vi.advanceTimersByTimeAsync(29_999);
    expect(mocks.inspect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await offer;

    expect(mocks.inspect).toHaveBeenCalledWith({ verifyScreen: true });
    expect(mocks.requestPermission).toHaveBeenCalledWith('SETUP');
  });

  it('drops a delayed offer when the user signs out meanwhile', async () => {
    const offer = offerPermissionSetupOnStartup({ openedAtLogin: true });
    resetPermissionSetupOffer();
    await vi.advanceTimersByTimeAsync(30_000);
    await offer;

    expect(mocks.inspect).not.toHaveBeenCalled();
    expect(mocks.requestPermission).not.toHaveBeenCalled();
  });

  it('does not open the prompt for a blank first probe that then recovers', async () => {
    mocks.inspect.mockResolvedValue(verdict('CHECKING'));
    mocks.recheck.mockResolvedValue(verdict('READY'));

    const offer = offerPermissionSetupOnStartup();
    await vi.advanceTimersByTimeAsync(5_000);
    await offer;

    expect(mocks.recheck).toHaveBeenCalledOnce();
    expect(mocks.requestPermission).not.toHaveBeenCalled();
  });
});

describe('timer commands from any surface', () => {
  const RUNNING = { state: 'RUNNING', paused: false };

  beforeEach(() => {
    mocks.blocked = false;
    mocks.clearTimerPrompts.mockReset();
    mocks.requestPermission.mockReset();
    for (const fn of Object.values(mocks.timer)) fn.mockReset().mockResolvedValue(RUNNING);
    mocks.timer.status.mockReturnValue(RUNNING);
  });

  it.each([
    ['start', () => startTracking('task-1')],
    ['resume', () => resumeTracking()],
    ['stop', () => stopTracking()],
    ['pause', () => pauseTracking()],
  ])('%s retires idle and welcome-back prompts it just answered', async (_name, run) => {
    await run();
    expect(mocks.clearTimerPrompts).toHaveBeenCalledTimes(1);
  });

  it('leaves the prompts alone when the command was refused for permissions', async () => {
    mocks.blocked = true;
    mocks.timer.resume.mockRejectedValue({ readiness: { ready: false } });

    const result = await resumeTracking();

    expect(result.ok).toBe(false);
    expect(mocks.clearTimerPrompts).not.toHaveBeenCalled();
    expect(mocks.requestPermission).toHaveBeenCalledWith('RESUME_ENTRY');
  });
});
