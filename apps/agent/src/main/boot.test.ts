import { describe, expect, it, vi } from 'vitest';
import { runBoot, type BootSteps } from './boot';

function steps(overrides: Partial<BootSteps> = {}): { steps: BootSteps; order: string[] } {
  const order: string[] = [];
  const record = (name: string) => () => {
    order.push(name);
  };
  const recordAsync = (name: string) => async () => {
    order.push(name);
  };
  return {
    order,
    steps: {
      initializeWorkspaceTime: recordAsync('workspaceTime'),
      initTimerOnBoot: recordAsync('timerRecovery'),
      startTimerSyncDrain: record('timerSyncDrain'),
      startTick: record('tick'),
      startLocalServices: record('localServices'),
      onLocalReady: record('localReady'),
      refreshAgentConfig: recordAsync('config'),
      drainBacklogs: record('drains'),
      hasStoredSession: async () => {
        order.push('session');
        return true;
      },
      startHeartbeat: record('heartbeat'),
      offerPermissionSetup: record('permissionOffer'),
      startShiftMonitor: recordAsync('shift'),
      log: { warn: vi.fn() },
      ...overrides,
    },
  };
}

const never = () => new Promise<never>(() => undefined);

describe('boot', () => {
  it('binds the owner and starts the tick before anything touches the network', async () => {
    const { steps: s, order } = steps();

    const { online } = await runBoot(s);
    await online;

    expect(order).toEqual([
      'workspaceTime',
      'timerRecovery',
      'timerSyncDrain',
      'tick',
      'localServices',
      'localReady',
      'config',
      'drains',
      'session',
      'heartbeat',
      'permissionOffer',
      'shift',
    ]);
  });

  it('is usable even when the server never answers', async () => {
    const { steps: s, order } = steps({
      refreshAgentConfig: never,
      startShiftMonitor: never,
      hasStoredSession: never,
    });

    // runBoot resolving at all is the assertion: it must not wait on the network.
    await runBoot(s);

    expect(order).toEqual(['workspaceTime', 'timerRecovery', 'timerSyncDrain', 'tick', 'localServices', 'localReady']);
  });

  it('still starts the tick and accepts sign-in when timer recovery fails', async () => {
    const { steps: s, order } = steps({
      initTimerOnBoot: async () => {
        throw new Error('sqlite busy');
      },
    });

    await runBoot(s);

    expect(order).toContain('tick');
    expect(order).toContain('localReady');
    // The drain needs a booted timer.
    expect(order).not.toContain('timerSyncDrain');
    expect(s.log.warn).toHaveBeenCalledWith('boot: timer recovery failed', expect.anything());
  });

  it('skips the session work when nothing is stored, but still starts the shift monitor', async () => {
    const { steps: s, order } = steps({ hasStoredSession: async () => false });

    const { online } = await runBoot(s);
    await online;

    expect(order).not.toContain('heartbeat');
    expect(order).not.toContain('permissionOffer');
    expect(order.at(-1)).toBe('shift');
  });

  it('keeps going past a failed config refresh', async () => {
    const { steps: s, order } = steps({
      refreshAgentConfig: async () => {
        throw new Error('offline');
      },
    });

    const { online } = await runBoot(s);
    await online;

    expect(order).toEqual(expect.arrayContaining(['drains', 'heartbeat', 'shift']));
  });
});
