import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  idleSeconds: 0,
  running: true,
  paused: false,
  threshold: 10,
  warning: null as number | null,
}));

vi.mock('electron', () => ({ powerMonitor: { getSystemIdleTime: () => state.idleSeconds } }));
vi.mock('../timer', () => ({
  getTimerService: () => ({
    status: () => state.running
      ? { state: 'RUNNING', paused: state.paused }
      : { state: 'IDLE' },
  }),
}));
vi.mock('../agentConfig', () => ({
  getIdleThresholdSec: () => state.threshold,
  getIdleWarningSeconds: () => state.warning,
}));
vi.mock('../../env', () => ({ IDLE_POLL_MS: 1000 }));
vi.mock('../../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { IdleMonitor } = await import('./monitor');

const tick = (monitor: InstanceType<typeof IdleMonitor>) =>
  (monitor as unknown as { tick(): Promise<void> }).tick();

function setup() {
  const handlers = {
    onWarning: vi.fn(async () => true),
    onWarningCancelled: vi.fn(),
    // The real handler pauses the timer; the fake does the same to the state
    // the monitor reads back.
    onIdlePause: vi.fn(async (_idleStartedAt: number) => {
      state.paused = true;
    }),
    onIdlePrompt: vi.fn((_idleStartedAt: number) => true),
  };
  return { handlers, monitor: new IdleMonitor(handlers) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-07-16T12:00:00.000Z'));
});

afterEach(() => {
  state.idleSeconds = 0;
  state.running = true;
  state.paused = false;
  state.threshold = 10;
  state.warning = null;
  vi.useRealTimers();
});

describe('IdleMonitor two-stage gating', () => {
  it('keeps the existing direct idle pause when warning is disabled', async () => {
    state.idleSeconds = 10;
    const { handlers, monitor } = setup();

    await tick(monitor);

    expect(handlers.onWarning).not.toHaveBeenCalled();
    expect(handlers.onIdlePause).toHaveBeenCalledTimes(1);
    expect(handlers.onIdlePrompt).toHaveBeenCalledTimes(1);
  });

  it('shows one warning before the threshold without pausing', async () => {
    state.warning = 3;
    state.idleSeconds = 7;
    const { handlers, monitor } = setup();

    await tick(monitor);
    await tick(monitor);

    expect(handlers.onWarning).toHaveBeenCalledTimes(1);
    expect(handlers.onWarning).toHaveBeenCalledWith(expect.objectContaining({
      deadlineAt: Date.now() + 3000,
    }));
    expect(handlers.onIdlePause).not.toHaveBeenCalled();
    monitor.resolve();
  });

  it('dismisses the warning automatically when activity returns', async () => {
    state.warning = 3;
    state.idleSeconds = 7;
    const { handlers, monitor } = setup();
    await tick(monitor);

    state.idleSeconds = 0;
    await tick(monitor);

    expect(handlers.onWarningCancelled).toHaveBeenCalledTimes(1);
  });

  it('dismisses the warning immediately when tracked input returns', async () => {
    state.warning = 3;
    state.idleSeconds = 7;
    const { handlers, monitor } = setup();
    await tick(monitor);

    monitor.noteActivity();

    expect(handlers.onWarningCancelled).toHaveBeenCalledTimes(1);
  });

  it('transitions the warning into the durable idle prompt at the deadline', async () => {
    state.warning = 3;
    state.idleSeconds = 7;
    const { handlers, monitor } = setup();
    await tick(monitor);

    vi.setSystemTime(Date.now() + 3000);
    state.idleSeconds = 10;
    await tick(monitor);

    expect(handlers.onIdlePause).toHaveBeenCalledTimes(1);
    expect(handlers.onIdlePrompt).toHaveBeenCalledTimes(1);
  });

  it('retries presenting a paused idle prompt after a coordinator conflict', async () => {
    state.idleSeconds = 10;
    const { handlers, monitor } = setup();
    handlers.onIdlePrompt.mockReturnValueOnce(false).mockReturnValueOnce(true);

    await tick(monitor);
    await tick(monitor);
    await tick(monitor);

    expect(handlers.onIdlePrompt).toHaveBeenCalledTimes(2);
  });

  it('never warns or pauses when the timer is not accruing', async () => {
    state.warning = 3;
    state.idleSeconds = 20;
    state.paused = true;
    const { handlers, monitor } = setup();

    await tick(monitor);

    expect(handlers.onWarning).not.toHaveBeenCalled();
    expect(handlers.onIdlePause).not.toHaveBeenCalled();
  });

  it('clears a warning while machine-away handling is active', async () => {
    state.warning = 3;
    state.idleSeconds = 7;
    const { handlers, monitor } = setup();
    await tick(monitor);

    monitor.suspend();
    await tick(monitor);

    expect(handlers.onWarningCancelled).toHaveBeenCalledTimes(1);
  });
});

describe('IdleMonitor — a prompt that could not be shown yet', () => {
  it('pauses once and only re-asks for the prompt while it waits', async () => {
    state.idleSeconds = 10;
    const { handlers, monitor } = setup();
    handlers.onIdlePrompt.mockReturnValue(false); // another prompt owns the screen

    for (let i = 0; i < 5; i += 1) await tick(monitor);

    expect(handlers.onIdlePause).toHaveBeenCalledTimes(1);
    expect(handlers.onIdlePrompt).toHaveBeenCalledTimes(5);
  });

  it('never re-pauses a timer the person resumed while the prompt was pending', async () => {
    state.idleSeconds = 10;
    const { handlers, monitor } = setup();
    handlers.onIdlePrompt.mockReturnValue(false);
    await tick(monitor);

    // Resumed from the popover: accruing again, and back at the keyboard.
    state.paused = false;
    state.idleSeconds = 0;
    await tick(monitor);
    await tick(monitor);

    expect(handlers.onIdlePause).toHaveBeenCalledTimes(1);
    expect(handlers.onIdlePrompt).toHaveBeenCalledTimes(1);
  });

  it('drops the pending prompt once the timer is stopped elsewhere', async () => {
    state.idleSeconds = 10;
    const { handlers, monitor } = setup();
    handlers.onIdlePrompt.mockReturnValue(false);
    await tick(monitor);

    state.running = false;
    await tick(monitor);
    await tick(monitor);

    expect(handlers.onIdlePrompt).toHaveBeenCalledTimes(1);
  });

  it('retries the pause itself when writing it failed', async () => {
    state.idleSeconds = 10;
    const { handlers, monitor } = setup();
    handlers.onIdlePause.mockRejectedValueOnce(new Error('disk'));

    await tick(monitor);
    expect(handlers.onIdlePrompt).not.toHaveBeenCalled();
    await tick(monitor);

    expect(handlers.onIdlePause).toHaveBeenCalledTimes(2);
    expect(handlers.onIdlePrompt).toHaveBeenCalledTimes(1);
  });
});

describe('IdleMonitor — detection comes back after the prompt goes', () => {
  it('stays off while the idle prompt is up, and detects again once resolved', async () => {
    state.idleSeconds = 10;
    const { handlers, monitor } = setup();
    await tick(monitor);
    await tick(monitor);
    expect(handlers.onIdlePause).toHaveBeenCalledTimes(1);

    // The prompt went away by some path other than its own buttons; the owner
    // forwards that as resolve(). The person resumed and went idle again.
    monitor.resolve();
    state.paused = false;
    await tick(monitor);

    expect(handlers.onIdlePause).toHaveBeenCalledTimes(2);
  });
});
