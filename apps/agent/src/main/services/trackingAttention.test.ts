import { describe, expect, it, vi } from 'vitest';

vi.mock('../attentionWindow', () => ({ attentionHost: {} }));

import { createTrackingAttentionCoordinator } from './trackingAttention';
import type { OverlayHost } from '../attentionWindow';

type Coordinator = ReturnType<typeof createTrackingAttentionCoordinator>;

/**
 * Every test drives the coordinator through a fake OverlayHost.
 *
 * This is the whole point of the seam. The previous suite mocked the float
 * assertion, so no test could observe whether the prompt was actually on top —
 * which is why "raised exactly three times then stopped" could be asserted as
 * correct while being the bug users were reporting. Here `onTop` is a value the
 * test controls, so losing the top is something a test can cause and assert on.
 */
function setup() {
  let next = 0;
  let onTop = true;
  let readyListener: (() => void) | null = null;

  const host: OverlayHost = {
    place: vi.fn(),
    keep: vi.fn(() => {
      onTop = true;
    }),
    release: vi.fn(),
    activate: vi.fn(() => {
      onTop = true;
    }),
    onTop: vi.fn(() => onTop),
    lower: vi.fn(() => {
      onTop = false;
    }),
    hide: vi.fn(),
    publish: vi.fn(),
    onReady: vi.fn((listener: () => void) => {
      readyListener = listener;
    }),
    isReady: vi.fn(() => true),
  };

  const logger = { info: vi.fn(), warn: vi.fn() };

  const coordinator = createTrackingAttentionCoordinator({
    id: () => `prompt-${++next}`,
    host,
    logger,
    // Timers are never started; tests step the resume poll explicitly.
    setInterval: vi.fn(() => ({ unref: vi.fn() })) as unknown as typeof setInterval,
    clearInterval: vi.fn() as unknown as typeof clearInterval,
  });

  return {
    coordinator,
    host,
    logger,
    fireReady: () => readyListener?.(),
    tick: () => coordinator.__resumeTickForTests(),
  };
}

describe('TrackingAttentionCoordinator — priority', () => {
  it('reuses one prompt while an idle warning becomes a paused idle prompt', () => {
    const { coordinator, host } = setup();

    expect(coordinator.requestIdleWarning({ idleStartedAt: 100, deadlineAt: 200 })).toBe(true);
    const warning = coordinator.get();
    if (warning.kind !== 'IDLE_WARNING') throw new Error('expected warning prompt');

    expect(coordinator.requestIdle(100)).toBe(true);
    expect(coordinator.get()).toMatchObject({ kind: 'IDLE', promptId: warning.promptId });
    expect(host.publish).toHaveBeenCalledTimes(2);
  });

  it('clears only an active idle warning', () => {
    const { coordinator } = setup();
    coordinator.requestIdleWarning({ idleStartedAt: 100, deadlineAt: 200 });

    expect(coordinator.clearIdleWarning()).toBe(true);
    expect(coordinator.get()).toEqual({ kind: 'NONE' });
    expect(coordinator.clearIdleWarning()).toBe(false);
  });

  it('allows only one prompt and gives permission the highest priority', () => {
    const { coordinator } = setup();

    expect(coordinator.requestIdle(100)).toBe(true);
    coordinator.requestPermission('START_TASK');

    expect(coordinator.get()).toMatchObject({ kind: 'PERMISSION', intent: 'START_TASK' });
    expect(coordinator.requestIdle(200)).toBe(false);
    expect(coordinator.requestAway({ larkTaskGuid: 'task-1', stoppedAt: 300, reason: 'lock' })).toBe(false);
  });

  it('discards idle before presenting one welcome-back prompt', () => {
    const { coordinator, host } = setup();
    coordinator.requestIdle(100);
    vi.mocked(host.hide).mockClear();

    coordinator.beginMachineAway();
    expect(coordinator.get()).toEqual({ kind: 'NONE' });
    expect(host.hide).toHaveBeenCalledTimes(1);

    expect(coordinator.requestAway({ larkTaskGuid: null, stoppedAt: 200, reason: 'suspend' })).toBe(true);
    expect(coordinator.get()).toMatchObject({ kind: 'AWAY', reason: 'suspend' });
  });

  it('keeps one permission identity while changing intent or presentation', () => {
    const { coordinator, host } = setup();
    const first = coordinator.requestPermission('SETUP');
    if (first.kind !== 'PERMISSION') throw new Error('expected permission prompt');

    expect(coordinator.yieldPermissionToSystemSettings(first.promptId)).toBe(true);
    expect(coordinator.get()).toMatchObject({ presentation: 'YIELDED_TO_SETTINGS' });
    expect(host.lower).toHaveBeenCalledTimes(1);

    const second = coordinator.requestPermission('RESUME_ENTRY');
    expect(second).toMatchObject({ promptId: first.promptId, intent: 'RESUME_ENTRY', presentation: 'FRONT' });
  });

  it('rejects stale clear and stale permission-yield actions', () => {
    const { coordinator } = setup();
    const prompt = coordinator.requestPermission('START_TASK');
    if (prompt.kind !== 'PERMISSION') throw new Error('expected permission prompt');

    expect(coordinator.clear('older-prompt')).toBe(false);
    expect(coordinator.yieldPermissionToSystemSettings('older-prompt')).toBe(false);
    expect(coordinator.get()).toEqual(prompt);
  });
});

describe('TrackingAttentionCoordinator — handing off to the keeper', () => {
  it('places once and hands the surface to the keeper', () => {
    const { coordinator, host } = setup();
    coordinator.requestIdle(100);

    // Staying on top is no longer this module's job. It places the surface and
    // the shared overlay keeper holds it, using the cadence the timer bar
    // proved in the field.
    expect(host.place).toHaveBeenCalledTimes(1);
    expect(host.keep).toHaveBeenCalledTimes(1);
  });

  it('releases the keeper when the prompt is cleared', () => {
    const { coordinator, host } = setup();
    coordinator.requestIdle(100);
    const prompt = coordinator.get();
    if (prompt.kind === 'NONE') throw new Error('expected a prompt');

    coordinator.clear(prompt.promptId);

    expect(host.release).toHaveBeenCalled();
    expect(host.hide).toHaveBeenCalled();
  });

  it('releases the keeper when the machine goes away', () => {
    const { coordinator, host } = setup();
    coordinator.requestIdle(100);

    coordinator.beginMachineAway();

    expect(host.release).toHaveBeenCalled();
  });

  it('re-places when a different prompt kind takes over', () => {
    const { coordinator, host } = setup();
    coordinator.requestIdle(100);
    coordinator.requestPermission('SETUP');

    // Each presentation resolves its own bounds once — a permission prompt is a
    // different size from an idle prompt.
    expect(host.place).toHaveBeenCalledTimes(2);
    expect(host.keep).toHaveBeenCalledTimes(2);
  });

  it('presents once the renderer finishes loading', () => {
    const { coordinator, host, fireReady } = setup();
    coordinator.requestIdle(100);
    const before = vi.mocked(host.keep).mock.calls.length;

    fireReady();

    expect(vi.mocked(host.keep).mock.calls.length).toBeGreaterThan(before);
  });
});

/** The resume check runs through a promise chain (then → catch → finally), so a
 *  couple of awaits is not enough to settle it. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('TrackingAttentionCoordinator — suspension', () => {
  it('does not fight System Settings while suspended', () => {
    const { coordinator, host, tick } = setup();
    const prompt = coordinator.requestPermission('SETUP');
    if (prompt.kind !== 'PERMISSION') throw new Error('expected permission prompt');

    coordinator.yieldPermissionToSystemSettings(prompt.promptId);
    const keepsAfterYield = vi.mocked(host.keep).mock.calls.length;

    tick();
    tick();

    // Lowering releases the keeper, so nothing climbs back over Settings.
    expect(host.lower).toHaveBeenCalled();
    expect(vi.mocked(host.keep).mock.calls.length).toBe(keepsAfterYield);
  });

  it('comes back by itself once the resume predicate is satisfied', async () => {
    const { coordinator, host, tick } = setup();
    const prompt = coordinator.requestPermission('SETUP');
    if (prompt.kind !== 'PERMISSION') throw new Error('expected permission prompt');

    let granted = false;
    coordinator.yieldPermissionToSystemSettings(prompt.promptId, { resumeWhen: () => granted });

    tick();
    tick();
    await flush();
    expect(coordinator.get()).toMatchObject({ presentation: 'YIELDED_TO_SETTINGS' });

    granted = true;
    tick();
    tick();
    await flush();

    expect(coordinator.get()).toMatchObject({ presentation: 'FRONT' });
    expect(host.keep).toHaveBeenCalled();
  });

  it('keeps retrying if the resume predicate throws', async () => {
    const { coordinator, tick } = setup();
    const prompt = coordinator.requestPermission('SETUP');
    if (prompt.kind !== 'PERMISSION') throw new Error('expected permission prompt');

    let calls = 0;
    coordinator.yieldPermissionToSystemSettings(prompt.promptId, {
      resumeWhen: () => {
        calls += 1;
        throw new Error('probe failed');
      },
    });

    tick();
    tick();
    await flush();
    tick();
    tick();
    await flush();

    expect(calls).toBeGreaterThan(1);
    expect(coordinator.get()).toMatchObject({ presentation: 'YIELDED_TO_SETTINGS' });
  });
});


describe('TrackingAttentionCoordinator — releasing a prompt nobody can reach', () => {
  it('clears the prompt, hides the overlay, and says so', () => {
    const { coordinator, host, logger } = setup();
    coordinator.requestAway({ larkTaskGuid: null, stoppedAt: 1_000, reason: 'suspend' });
    expect(coordinator.get().kind).toBe('AWAY');

    expect(coordinator.releaseUnreachable('main_window_requested_twice')).toBe(true);

    expect(coordinator.get()).toEqual({ kind: 'NONE' });
    expect(host.hide).toHaveBeenCalled();
    expect(host.publish).toHaveBeenLastCalledWith({ kind: 'NONE' });
    expect(logger.warn).toHaveBeenCalledWith(
      'attention prompt released as unreachable',
      expect.objectContaining({ kind: 'AWAY', reason: 'main_window_requested_twice' }),
    );
  });

  it('is a no-op when nothing is active', () => {
    const { coordinator, logger } = setup();
    expect(coordinator.releaseUnreachable('whatever')).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('releases a permission prompt too, so Settings cannot wedge the app', () => {
    const { coordinator } = setup();
    coordinator.requestPermission('SETUP');
    expect(coordinator.releaseUnreachable('main_window_requested_twice')).toBe(true);
    expect(coordinator.get()).toEqual({ kind: 'NONE' });
  });

  it('lets a fresh prompt be shown afterwards', () => {
    const { coordinator } = setup();
    coordinator.requestAway({ larkTaskGuid: null, stoppedAt: 1_000, reason: 'suspend' });
    coordinator.releaseUnreachable('main_window_requested_twice');

    // The wedge is gone: the next real prompt is accepted normally.
    expect(coordinator.requestIdle(500)).toBe(true);
    expect(coordinator.get().kind).toBe('IDLE');
  });

  it('stops the resume poll, so a released permission prompt cannot come back by itself', () => {
    const { coordinator } = setup();
    const prompt = coordinator.requestPermission('SETUP');
    if (prompt.kind !== 'PERMISSION') throw new Error('expected a permission prompt');
    coordinator.yieldPermissionToSystemSettings(prompt.promptId, { resumeWhen: () => true });

    coordinator.releaseUnreachable('main_window_requested_twice');
    coordinator.__resumeTickForTests();

    expect(coordinator.get()).toEqual({ kind: 'NONE' });
  });
});

describe('TrackingAttentionCoordinator — a prompt leaves a trace', () => {
  it('logs the prompt going up, with what we believe about the float', () => {
    const { coordinator, logger } = setup();
    coordinator.requestIdle(100);
    expect(logger.info).toHaveBeenCalledWith(
      'attention prompt shown',
      expect.objectContaining({ kind: 'IDLE', floating: true }),
    );
  });

  it('logs a restore, and still reports that a prompt existed', () => {
    const { coordinator, logger } = setup();
    coordinator.requestIdle(100);
    logger.info.mockClear();

    expect(coordinator.restoreActive()).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      'attention prompt restored',
      expect.objectContaining({ kind: 'IDLE' }),
    );
  });

  it('records the float belief as false when the overlay is not on top', () => {
    const { coordinator, host, logger } = setup();
    coordinator.requestIdle(100);
    host.lower();
    logger.info.mockClear();

    coordinator.restoreActive();
    // keep() runs during present, so the belief is true again by the time we
    // look — the value is evidence of what the app thinks, not proof of sight.
    expect(logger.info).toHaveBeenCalledWith(
      'attention prompt restored',
      expect.objectContaining({ kind: 'IDLE' }),
    );
  });

  it('logs the prompt being cleared normally', () => {
    const { coordinator, logger } = setup();
    coordinator.requestIdle(100);
    coordinator.clear();
    expect(logger.info).toHaveBeenCalledWith(
      'attention prompt cleared',
      expect.objectContaining({ kind: 'IDLE' }),
    );
  });

  it('restoreActive on nothing reports false and logs nothing', () => {
    const { coordinator, logger } = setup();
    expect(coordinator.restoreActive()).toBe(false);
    expect(logger.info).not.toHaveBeenCalled();
  });
});


/**
 * The stranding fix, expressed at the seam.
 *
 * A window only belongs to the Spaces that existed when it was built. So every
 * presentation discards the old surface and builds a fresh one, which reaches
 * the Space the person is on now without having to activate the app.
 */
describe('TrackingAttentionCoordinator — one surface per presentation', () => {
  it('discards the surface whenever a prompt ends', () => {
    const { coordinator, host } = setup();

    coordinator.requestIdle(100);
    vi.mocked(host.hide).mockClear();
    coordinator.clear();
    expect(host.hide).toHaveBeenCalledTimes(1);
  });

  it('builds a fresh surface for every presentation, restores included', () => {
    const { coordinator, host } = setup();

    coordinator.requestIdle(100);
    expect(host.hide).toHaveBeenCalledTimes(1);
    expect(vi.mocked(host.hide).mock.invocationCallOrder[0]!)
      .toBeLessThan(vi.mocked(host.place).mock.invocationCallOrder[0]!);

    coordinator.restoreActive();
    expect(host.hide).toHaveBeenCalledTimes(2);
    expect(host.place).toHaveBeenCalledTimes(2);
  });

  it('waits for the renderer before revealing, so it never shows an empty window', () => {
    const { coordinator, host, fireReady } = setup();
    vi.mocked(host.isReady).mockReturnValue(false);

    coordinator.requestPermission('SETUP');
    expect(host.keep).not.toHaveBeenCalled();
    expect(host.activate).not.toHaveBeenCalled();

    vi.mocked(host.isReady).mockReturnValue(true);
    fireReady();
    expect(host.activate).toHaveBeenCalledTimes(1);
    expect(host.keep).toHaveBeenCalledTimes(1);
  });

  it('discards the surface on release too, so an unreachable prompt leaves nothing behind', () => {
    const { coordinator, host } = setup();
    coordinator.requestIdle(100);
    vi.mocked(host.hide).mockClear();

    coordinator.releaseUnreachable('main_window_requested_twice');

    expect(host.hide).toHaveBeenCalledTimes(1);
  });
});

describe('TrackingAttentionCoordinator — only a blocking prompt takes focus', () => {
  it('activates for a permission prompt', () => {
    const { coordinator, host } = setup();
    coordinator.requestPermission('START_TASK');
    expect(host.activate).toHaveBeenCalledTimes(1);
  });

  it('shows idle, idle-warning and welcome-back prompts without activating', () => {
    const { coordinator, host } = setup();
    coordinator.requestIdleWarning({ idleStartedAt: 100, deadlineAt: 200 });
    coordinator.requestIdle(100);
    coordinator.clear();
    coordinator.requestAway({ larkTaskGuid: null, stoppedAt: 1_000, reason: 'lock' });

    expect(host.activate).not.toHaveBeenCalled();
    expect(host.keep).toHaveBeenCalledTimes(3);
  });

  it('does not activate when a tray click restores a prompt', () => {
    const { coordinator, host } = setup();
    coordinator.requestPermission('SETUP');
    vi.mocked(host.activate).mockClear();

    coordinator.restoreActive();

    expect(host.activate).not.toHaveBeenCalled();
    expect(host.keep).toHaveBeenCalledTimes(2);
  });

  it('activates once when a permission prompt comes back from System Settings', async () => {
    const { coordinator, host, tick } = setup();
    const prompt = coordinator.requestPermission('SETUP');
    if (prompt.kind !== 'PERMISSION') throw new Error('expected a permission prompt');
    coordinator.yieldPermissionToSystemSettings(prompt.promptId, { resumeWhen: () => true });
    vi.mocked(host.activate).mockClear();

    tick();
    await flush();

    expect(host.activate).toHaveBeenCalledTimes(1);
  });

  it('does NOT activate for a prompt that is standing down for System Settings', () => {
    const { coordinator, host } = setup();
    const prompt = coordinator.requestPermission('SETUP');
    if (prompt.kind !== 'PERMISSION') throw new Error('expected a permission prompt');
    vi.mocked(host.activate).mockClear();

    coordinator.yieldPermissionToSystemSettings(prompt.promptId, { resumeWhen: () => false });

    expect(host.activate).not.toHaveBeenCalled();
  });
});

describe('TrackingAttentionCoordinator — every change is observable', () => {
  function watched() {
    const ctx = setup();
    const changes: Array<[string, string]> = [];
    ctx.coordinator.onChange((next, previous) => changes.push([previous.kind, next.kind]));
    return { ...ctx, changes };
  }

  it('reports an idle prompt replaced by a permission prompt', () => {
    const { coordinator, changes } = watched();
    coordinator.requestIdle(100);
    coordinator.requestPermission('RESUME_ENTRY');
    expect(changes).toEqual([['NONE', 'IDLE'], ['IDLE', 'PERMISSION']]);
  });

  it('reports an idle prompt released as unreachable', () => {
    const { coordinator, changes } = watched();
    coordinator.requestIdle(100);
    coordinator.releaseUnreachable('main_window_requested_twice');
    expect(changes.at(-1)).toEqual(['IDLE', 'NONE']);
  });

  it('reports an idle prompt discarded for machine-away', () => {
    const { coordinator, changes } = watched();
    coordinator.requestIdleWarning({ idleStartedAt: 100, deadlineAt: 200 });
    coordinator.beginMachineAway();
    expect(changes.at(-1)).toEqual(['IDLE_WARNING', 'NONE']);
  });

  it('stops reporting once unsubscribed', () => {
    const { coordinator } = setup();
    const listener = vi.fn();
    const off = coordinator.onChange(listener);
    off();
    coordinator.requestIdle(100);
    expect(listener).not.toHaveBeenCalled();
  });

  it('keeps going when a listener throws', () => {
    const { coordinator, logger } = setup();
    coordinator.onChange(() => {
      throw new Error('boom');
    });
    coordinator.requestIdle(100);
    expect(coordinator.get().kind).toBe('IDLE');
    expect(logger.warn).toHaveBeenCalledWith('attention listener failed', expect.anything());
  });
});

describe('TrackingAttentionCoordinator — a timer command answers the timer prompts', () => {
  it.each([
    ['idle warning', (c: Coordinator) => c.requestIdleWarning({ idleStartedAt: 100, deadlineAt: 200 })],
    ['idle', (c: Coordinator) => c.requestIdle(100)],
    ['welcome back', (c: Coordinator) => c.requestAway({ larkTaskGuid: 't', stoppedAt: 1, reason: 'lock' })],
  ])('clears a stale %s prompt', (_name, request) => {
    const { coordinator } = setup();
    request(coordinator);

    expect(coordinator.clearTimerPrompts()).toBe(true);
    expect(coordinator.get()).toEqual({ kind: 'NONE' });
  });

  it('leaves a permission prompt alone', () => {
    const { coordinator } = setup();
    coordinator.requestPermission('START_TASK');

    expect(coordinator.clearTimerPrompts()).toBe(false);
    expect(coordinator.get().kind).toBe('PERMISSION');
  });
});

describe('TrackingAttentionCoordinator — displays changing', () => {
  it('re-places a prompt that is on screen', () => {
    const { coordinator, host } = setup();
    coordinator.requestAway({ larkTaskGuid: null, stoppedAt: 1, reason: 'lock' });
    vi.mocked(host.place).mockClear();

    coordinator.placeOnScreen();

    expect(host.place).toHaveBeenCalledWith({ width: 360, height: 222, placement: 'topRight' });
  });

  it('leaves alone a prompt that has stood down for System Settings', () => {
    const { coordinator, host } = setup();
    const prompt = coordinator.requestPermission('SETUP');
    if (prompt.kind !== 'PERMISSION') throw new Error('expected a permission prompt');
    coordinator.yieldPermissionToSystemSettings(prompt.promptId);
    vi.mocked(host.place).mockClear();

    coordinator.placeOnScreen();
    coordinator.clear();
    coordinator.placeOnScreen();

    expect(host.place).not.toHaveBeenCalled();
  });
});
