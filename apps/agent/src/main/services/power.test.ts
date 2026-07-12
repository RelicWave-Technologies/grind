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

  it('deduplicates resume and unlock into one wake lifecycle', async () => {
    const onWake = vi.fn();
    const onVisibilityReturn = vi.fn();
    const onReturnComplete = vi.fn();
    registerPowerEvents({ onWake, onVisibilityReturn, onReturnComplete });

    mocks.listeners.get('resume')!();
    mocks.listeners.get('unlock-screen')!();
    await settle();

    expect(onWake).toHaveBeenCalledTimes(1);
    expect(onVisibilityReturn).toHaveBeenCalledTimes(1);
    expect(onReturnComplete).toHaveBeenCalledTimes(1);
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

  it('offers to resume after a lock that stopped a running timer', async () => {
    const onReturnFromAway = vi.fn();
    mocks.status.mockReturnValue({ state: 'RUNNING', entryId: 'e1', larkTaskGuid: 'task-1', startedAt: 0, workedMs: 0, paused: false });
    registerPowerEvents({ onWake: vi.fn(), onReturnFromAway });

    mocks.listeners.get('lock-screen')!();
    await settle();
    vi.mocked(Date.now).mockReturnValue(1_700_000_000_000 + 61_000); // returned 61s later
    mocks.listeners.get('unlock-screen')!();
    await settle();

    expect(onReturnFromAway).toHaveBeenCalledWith({ larkTaskGuid: 'task-1', stoppedAt: 1_700_000_000_000, reason: 'lock' });
  });

  it('offers to resume after sleep/suspend too', async () => {
    const onReturnFromAway = vi.fn();
    mocks.status.mockReturnValue({ state: 'RUNNING', entryId: 'e1', larkTaskGuid: null, startedAt: 0, workedMs: 0, paused: false });
    registerPowerEvents({ onWake: vi.fn(), onReturnFromAway });

    mocks.listeners.get('suspend')!();
    await settle();
    vi.mocked(Date.now).mockReturnValue(1_700_000_000_000 + 120_000);
    mocks.listeners.get('resume')!();
    await settle();

    expect(onReturnFromAway).toHaveBeenCalledWith({ larkTaskGuid: null, stoppedAt: 1_700_000_000_000, reason: 'suspend' });
  });

  it('offers to resume even after a brief away (no minimum duration)', async () => {
    const onReturnFromAway = vi.fn();
    mocks.status.mockReturnValue({ state: 'RUNNING', entryId: 'e1', larkTaskGuid: null, startedAt: 0, workedMs: 0, paused: false });
    registerPowerEvents({ onWake: vi.fn(), onReturnFromAway });

    mocks.listeners.get('lock-screen')!();
    await settle();
    vi.mocked(Date.now).mockReturnValue(1_700_000_000_000 + 5_000); // only 5s away
    mocks.listeners.get('unlock-screen')!();
    await settle();

    expect(onReturnFromAway).toHaveBeenCalledWith({ larkTaskGuid: null, stoppedAt: 1_700_000_000_000, reason: 'lock' });
  });

  it('does not offer resume when nothing was tracking', async () => {
    const onReturnFromAway = vi.fn(); // status stays IDLE (beforeEach)
    registerPowerEvents({ onWake: vi.fn(), onReturnFromAway });

    mocks.listeners.get('suspend')!();
    await settle();
    vi.mocked(Date.now).mockReturnValue(1_700_000_000_000 + 120_000);
    mocks.listeners.get('resume')!();
    await settle();

    expect(onReturnFromAway).not.toHaveBeenCalled();
  });

  it('uses the first away event and ignores a duplicate lock/suspend pair', async () => {
    const onAwayStart = vi.fn();
    mocks.status.mockReturnValue({ state: 'RUNNING', larkTaskGuid: 'task-1', paused: false });
    registerPowerEvents({ onWake: vi.fn(), onAwayStart });

    mocks.listeners.get('lock-screen')!();
    mocks.listeners.get('suspend')!();
    await settle();

    expect(onAwayStart).toHaveBeenCalledTimes(1);
    expect(mocks.prepareForAway).toHaveBeenCalledTimes(1);
    expect(mocks.prepareForAway).toHaveBeenCalledWith('lock', 1_700_000_000_000);
  });

  it('waits for durable away cleanup before offering resume', async () => {
    let finish!: (value: unknown) => void;
    mocks.prepareForAway.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    mocks.status.mockReturnValue({ state: 'RUNNING', larkTaskGuid: 'task-1', paused: false });
    const onReturnFromAway = vi.fn();
    registerPowerEvents({ onWake: vi.fn(), onReturnFromAway });

    mocks.listeners.get('lock-screen')!();
    mocks.listeners.get('unlock-screen')!();
    await settle();
    expect(onReturnFromAway).not.toHaveBeenCalled();

    finish({ state: 'IDLE' });
    await settle();
    expect(onReturnFromAway).toHaveBeenCalledTimes(1);
  });

  it('retries cleanup once at the original boundary and never shows a false resume prompt', async () => {
    mocks.status.mockReturnValue({ state: 'RUNNING', larkTaskGuid: 'task-1', paused: false });
    mocks.prepareForAway.mockRejectedValue(new Error('disk unavailable'));
    const onReturnFromAway = vi.fn();
    const onReturnComplete = vi.fn();
    registerPowerEvents({ onWake: vi.fn(), onReturnFromAway, onReturnComplete });

    mocks.listeners.get('suspend')!();
    mocks.listeners.get('resume')!();
    await settle();
    await settle();

    expect(mocks.prepareForAway).toHaveBeenCalledTimes(2);
    expect(mocks.prepareForAway).toHaveBeenNthCalledWith(1, 'suspend', 1_700_000_000_000);
    expect(mocks.prepareForAway).toHaveBeenNthCalledWith(2, 'suspend', 1_700_000_000_000);
    expect(onReturnFromAway).not.toHaveBeenCalled();
    expect(onReturnComplete).toHaveBeenCalledTimes(1);
  });
});
