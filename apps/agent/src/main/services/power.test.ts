import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => unknown>();
  return {
    listeners,
    powerOn: vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
      listeners.set(event, listener);
    }),
    quit: vi.fn(),
    prepareForAway: vi.fn(),
    discardAway: vi.fn(),
    status: vi.fn(),
    runQuitCleanup: vi.fn(),
    broadcast: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: { quit: mocks.quit },
  powerMonitor: { on: mocks.powerOn },
}));

vi.mock('./timer', () => ({
  getTimerService: () => ({
    prepareForAway: mocks.prepareForAway,
    discardAway: mocks.discardAway,
    status: mocks.status,
  }),
}));

vi.mock('./quitCleanup', () => ({
  runQuitCleanup: mocks.runQuitCleanup,
}));

vi.mock('../broadcast', () => ({
  broadcast: mocks.broadcast,
}));

vi.mock('../logger', () => ({
  log: { info: mocks.info, warn: mocks.warn },
}));

import { registerPowerEvents } from './power';

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('registerPowerEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    mocks.prepareForAway.mockResolvedValue({ state: 'IDLE', workedMs: 0 });
    mocks.status.mockReturnValue({ state: 'IDLE', workedMs: 0 });
    mocks.runQuitCleanup.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('stops the timer durably on suspend', async () => {
    registerPowerEvents({ onWake: vi.fn() });

    mocks.listeners.get('suspend')!();
    await settle();

    expect(mocks.prepareForAway).toHaveBeenCalledWith('suspend', 1_700_000_000_000);
    expect(mocks.broadcast).toHaveBeenCalledWith('timer:status:push', { state: 'IDLE', workedMs: 0 });
  });

  it('stops the timer durably on lock-screen', async () => {
    registerPowerEvents({ onWake: vi.fn() });

    mocks.listeners.get('lock-screen')!();
    await settle();

    expect(mocks.prepareForAway).toHaveBeenCalledWith('lock', 1_700_000_000_000);
  });

  it('does not trim or resume tracking on resume and unlock', () => {
    const onWake = vi.fn();
    registerPowerEvents({ onWake });

    mocks.listeners.get('resume')!();
    mocks.listeners.get('unlock-screen')!();

    expect(onWake).toHaveBeenCalledTimes(2);
    expect(mocks.discardAway).not.toHaveBeenCalled();
    expect(mocks.prepareForAway).not.toHaveBeenCalled();
  });

  it('runs bounded quit cleanup on shutdown', async () => {
    registerPowerEvents({ onWake: vi.fn() });
    const preventDefault = vi.fn();

    mocks.listeners.get('shutdown')!({ preventDefault });
    await settle();

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(mocks.runQuitCleanup).toHaveBeenCalledWith('shutdown');
    expect(mocks.quit).toHaveBeenCalledTimes(1);
  });
});
