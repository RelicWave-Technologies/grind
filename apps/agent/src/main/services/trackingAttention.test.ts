import { describe, expect, it, vi } from 'vitest';

vi.mock('../attentionWindow', () => ({ attentionHost: {} }));

import { createTrackingAttentionCoordinator } from './trackingAttention';
import type { OverlayHost } from '../attentionWindow';

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
 * A window only reaches a Space it was not built into if something activates
 * it — on macOS that is `makeKeyAndOrderFront:`, which is what the original
 * prompt did on every show and what every rewrite since dropped. So the
 * coordinator's contract is: every presentation activates exactly once, and
 * holding never does.
 */
describe('TrackingAttentionCoordinator — presentation activates, holding does not', () => {
  it('releases the surface whenever a prompt ends', () => {
    const { coordinator, host } = setup();

    coordinator.requestIdle(100);
    coordinator.clear();
    expect(host.hide).toHaveBeenCalledTimes(1);

    coordinator.requestIdle(200);
    coordinator.clear();
    expect(host.hide).toHaveBeenCalledTimes(2);
  });

  it('places the surface again for every prompt rather than assuming it survived', () => {
    const { coordinator, host } = setup();

    coordinator.requestIdle(100);
    const placedForFirst = vi.mocked(host.place).mock.calls.length;
    coordinator.clear();

    coordinator.requestAway({ larkTaskGuid: null, stoppedAt: 1_000, reason: 'suspend' });

    // A second placement is what proves the coordinator does not depend on the
    // previous window still existing.
    expect(vi.mocked(host.place).mock.calls.length).toBeGreaterThan(placedForFirst);
  });

  it('hides on release too, so an unreachable prompt does not leave a window behind', () => {
    const { coordinator, host } = setup();
    coordinator.requestIdle(100);

    coordinator.releaseUnreachable('main_window_requested_twice');

    expect(host.hide).toHaveBeenCalledTimes(1);
  });
});


describe('TrackingAttentionCoordinator — activation is rationed to presentation', () => {
  it('activates when a prompt is shown', () => {
    const { coordinator, host } = setup();
    coordinator.requestIdle(100);
    expect(host.activate).toHaveBeenCalledTimes(1);
  });

  it('activates again when the prompt is restored, because that is a new ask', () => {
    const { coordinator, host } = setup();
    coordinator.requestIdle(100);
    vi.mocked(host.activate).mockClear();

    coordinator.restoreActive();

    expect(host.activate).toHaveBeenCalledTimes(1);
  });

  it('does NOT activate for a prompt that is standing down for System Settings', () => {
    const { coordinator, host } = setup();
    const prompt = coordinator.requestPermission('SETUP');
    if (prompt.kind !== 'PERMISSION') throw new Error('expected a permission prompt');
    vi.mocked(host.activate).mockClear();

    coordinator.yieldPermissionToSystemSettings(prompt.promptId, { resumeWhen: () => false });

    // Yielding is the opposite of asking for attention; stealing focus here
    // would sit on top of the very Settings pane the person was sent to.
    expect(host.activate).not.toHaveBeenCalled();
  });

  it('never activates more than once per presentation', () => {
    const { coordinator, host } = setup();
    coordinator.requestIdleWarning({ idleStartedAt: 100, deadlineAt: 200 });
    expect(host.activate).toHaveBeenCalledTimes(1);

    // The warning becoming a paused idle prompt is a second presentation.
    coordinator.requestIdle(100);
    expect(host.activate).toHaveBeenCalledTimes(2);
  });
});
