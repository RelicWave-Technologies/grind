import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ idleSeconds: 0, running: true, paused: false, threshold: 10 }));

vi.mock('electron', () => ({ powerMonitor: { getSystemIdleTime: () => state.idleSeconds } }));
vi.mock('../timer', () => ({
  getTimerService: () => ({
    status: () => state.running
      ? { state: 'RUNNING', paused: state.paused }
      : { state: 'IDLE' },
  }),
}));
vi.mock('../agentConfig', () => ({ getIdleThresholdSec: () => state.threshold }));
vi.mock('../../env', () => ({ IDLE_POLL_MS: 1000 }));
vi.mock('../../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const { IdleMonitor } = await import('./monitor');

// tick() is private; call it directly for deterministic, timer-free assertions.
const tick = (m: InstanceType<typeof IdleMonitor>) => (m as unknown as { tick(): Promise<void> }).tick();

afterEach(() => {
  state.idleSeconds = 0;
  state.running = true;
  state.paused = false;
  state.threshold = 10;
});

describe('IdleMonitor prompt gating', () => {
  it('does not re-prompt while a prompt is open, until resolve()', async () => {
    state.idleSeconds = 20;
    const onPrompt = vi.fn(async () => true);
    const m = new IdleMonitor(onPrompt);

    await tick(m);
    await tick(m);
    expect(onPrompt).toHaveBeenCalledTimes(1); // second tick guarded by `prompting`
    expect(m.isPrompting()).toBe(true);

    m.resolve();
    await tick(m);
    expect(onPrompt).toHaveBeenCalledTimes(2);
  });

  it('resets prompting when onPrompt fails, so a later idle can prompt again (#7)', async () => {
    state.idleSeconds = 20;
    let calls = 0;
    const onPrompt = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error('showIdlePrompt failed');
      return true;
    });
    const m = new IdleMonitor(onPrompt);

    await tick(m); // first attempt throws → must NOT wedge the flag
    expect(m.isPrompting()).toBe(false);

    await tick(m); // retries because the flag was reset
    expect(onPrompt).toHaveBeenCalledTimes(2);
    expect(m.isPrompting()).toBe(true); // second succeeded → stays open until resolve()
  });

  it('never prompts when the timer is not running', async () => {
    state.idleSeconds = 20;
    state.running = false;
    const onPrompt = vi.fn(async () => true);
    const m = new IdleMonitor(onPrompt);

    await tick(m);
    expect(onPrompt).not.toHaveBeenCalled();
  });

  it('never prompts while a running entry is paused', async () => {
    state.idleSeconds = 20;
    state.paused = true;
    const onPrompt = vi.fn(async () => true);
    const m = new IdleMonitor(onPrompt);

    await tick(m);
    expect(onPrompt).not.toHaveBeenCalled();
  });

  it('releases prompting when the coordinator rejects the idle prompt', async () => {
    state.idleSeconds = 20;
    const onPrompt = vi.fn(async () => false);
    const m = new IdleMonitor(onPrompt);

    await tick(m);
    expect(m.isPrompting()).toBe(false);
    await tick(m);
    expect(onPrompt).toHaveBeenCalledTimes(2);
  });

  it('clears and suppresses prompting while machine-away handling is active', async () => {
    state.idleSeconds = 20;
    const onPrompt = vi.fn(async () => true);
    const m = new IdleMonitor(onPrompt);

    await tick(m);
    m.suspend();
    await tick(m);
    expect(m.isPrompting()).toBe(false);
    expect(onPrompt).toHaveBeenCalledTimes(1);

    m.resume();
    await tick(m);
    expect(onPrompt).toHaveBeenCalledTimes(2);
  });
});
