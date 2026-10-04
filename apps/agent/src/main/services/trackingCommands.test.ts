import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CapabilityState } from '../../shared/tracking';

const mocks = vi.hoisted(() => ({
  inspect: vi.fn(),
  recheck: vi.fn(),
  requestPermission: vi.fn(),
}));

vi.mock('../broadcast', () => ({ broadcast: vi.fn() }));
vi.mock('./heartbeat', () => ({ sendHeartbeatNow: vi.fn() }));
vi.mock('./preferences', () => ({ rememberLastLarkTask: vi.fn() }));
vi.mock('./timer', () => ({ getTimerService: vi.fn() }));
vi.mock('./trackingAttention', () => ({
  getTrackingAttentionCoordinator: () => ({
    requestPermission: mocks.requestPermission,
    isPermissionActive: () => false,
    clear: vi.fn(),
  }),
}));
vi.mock('./trackingReadiness', () => ({
  isTrackingBlockedError: () => false,
  getTrackingReadinessService: () => ({ inspect: mocks.inspect, recheck: mocks.recheck }),
}));

import { offerPermissionSetupOnStartup, resetPermissionSetupOffer } from './trackingCommands';

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
