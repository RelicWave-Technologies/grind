import { describe, expect, it, vi } from 'vitest';

vi.mock('../attentionWindow', () => ({ attentionHost: {} }));
vi.mock('../windows/overlay', () => ({ holdPrompt: vi.fn() }));

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
function setup(opts: { onTop?: boolean } = {}) {
  let next = 0;
  let onTop = opts.onTop ?? true;
  let readyListener: (() => void) | null = null;

  const host: OverlayHost = {
    place: vi.fn(),
    raise: vi.fn(() => {
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

  const setPromptHeld = vi.fn();
  const coordinator = createTrackingAttentionCoordinator({
    id: () => `prompt-${++next}`,
    host,
    setPromptHeld,
    // Timers are never started; tests step the loop explicitly instead.
    setInterval: vi.fn(() => ({ unref: vi.fn() })) as unknown as typeof setInterval,
    clearInterval: vi.fn() as unknown as typeof clearInterval,
  });

  return {
    coordinator,
    host,
    setPromptHeld,
    loseTop: () => {
      onTop = false;
    },
    fireReady: () => readyListener?.(),
    tick: () => coordinator.__holdTickForTests(),
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

describe('TrackingAttentionCoordinator — holding the invariant', () => {
  it('re-raises when the host reports it has lost the top', () => {
    const { coordinator, host, tick, loseTop } = setup();
    coordinator.requestIdle(100);
    expect(host.raise).toHaveBeenCalledTimes(1);

    loseTop();
    tick();

    expect(host.raise).toHaveBeenCalledTimes(2);
  });

  it('keeps holding indefinitely — there is no bounded ladder to run out', () => {
    const { coordinator, host, tick, loseTop } = setup();
    coordinator.requestIdle(100);

    // Well past the old 1000ms ceiling, which is where enforcement used to stop
    // for the rest of the session.
    for (let i = 0; i < 50; i += 1) {
      loseTop();
      tick();
    }

    expect(host.raise).toHaveBeenCalledTimes(51);
  });

  it('does nothing while the prompt is still on top', () => {
    const { coordinator, host, tick } = setup();
    coordinator.requestIdle(100);
    expect(host.raise).toHaveBeenCalledTimes(1);

    tick();
    tick();
    tick();

    expect(host.raise).toHaveBeenCalledTimes(1);
    expect(host.place).toHaveBeenCalledTimes(1);
  });

  it('resolves bounds once per presentation, not once per raise', () => {
    const { coordinator, host, tick, loseTop } = setup();
    coordinator.requestIdle(100);

    loseTop();
    tick();
    loseTop();
    tick();

    // Re-placing on every raise is what let a prompt follow the cursor onto
    // another display mid-interaction.
    expect(host.place).toHaveBeenCalledTimes(1);
    expect(host.raise).toHaveBeenCalledTimes(3);
  });

  it('stops holding once the prompt is cleared', () => {
    const { coordinator, host, tick, loseTop } = setup();
    coordinator.requestIdle(100);
    const prompt = coordinator.get();
    if (prompt.kind === 'NONE') throw new Error('expected a prompt');

    coordinator.clear(prompt.promptId);
    loseTop();
    tick();

    expect(host.raise).toHaveBeenCalledTimes(1);
  });

  it('tells ambient overlays to stand down while held, and to resume after', () => {
    const { coordinator, setPromptHeld } = setup();

    coordinator.requestIdle(100);
    expect(setPromptHeld).toHaveBeenLastCalledWith(true);

    const prompt = coordinator.get();
    if (prompt.kind === 'NONE') throw new Error('expected a prompt');
    coordinator.clear(prompt.promptId);
    expect(setPromptHeld).toHaveBeenLastCalledWith(false);
  });

  it('presents once the renderer finishes loading', () => {
    const { coordinator, host, fireReady } = setup();
    coordinator.requestIdle(100);
    const raisesBefore = vi.mocked(host.raise).mock.calls.length;

    fireReady();

    expect(vi.mocked(host.raise).mock.calls.length).toBeGreaterThan(raisesBefore);
  });
});

/** The resume check runs through a promise chain (then → catch → finally), so a
 *  couple of awaits is not enough to settle it. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

describe('TrackingAttentionCoordinator — suspension', () => {
  it('does not fight System Settings while suspended', () => {
    const { coordinator, host, tick, setPromptHeld } = setup();
    const prompt = coordinator.requestPermission('SETUP');
    if (prompt.kind !== 'PERMISSION') throw new Error('expected permission prompt');

    coordinator.yieldPermissionToSystemSettings(prompt.promptId);
    const raisesAfterYield = vi.mocked(host.raise).mock.calls.length;

    tick();
    tick();

    expect(vi.mocked(host.raise).mock.calls.length).toBe(raisesAfterYield);
    expect(setPromptHeld).toHaveBeenLastCalledWith(false);
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
    expect(host.raise).toHaveBeenCalled();
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
