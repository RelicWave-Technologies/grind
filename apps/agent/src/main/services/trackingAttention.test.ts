import { describe, expect, it, vi } from 'vitest';

vi.mock('../attentionWindow', () => ({ attentionPresenter: {} }));

import { createTrackingAttentionCoordinator, type AttentionPresenter } from './trackingAttention';

function setup() {
  let next = 0;
  const presenter: AttentionPresenter = {
    show: vi.fn(),
    hide: vi.fn(),
    yieldToSystemSettings: vi.fn(),
    reassert: vi.fn(),
  };
  const coordinator = createTrackingAttentionCoordinator({
    id: () => `prompt-${++next}`,
    presenter,
  });
  return { coordinator, presenter };
}

describe('TrackingAttentionCoordinator', () => {
  it('allows only one prompt and gives permission the highest priority', () => {
    const { coordinator } = setup();

    expect(coordinator.requestIdle(100)).toBe(true);
    coordinator.requestPermission('START_TASK');

    expect(coordinator.get()).toMatchObject({ kind: 'PERMISSION', intent: 'START_TASK' });
    expect(coordinator.requestIdle(200)).toBe(false);
    expect(coordinator.requestAway({ larkTaskGuid: 'task-1', stoppedAt: 300, reason: 'lock' })).toBe(false);
  });

  it('discards idle before presenting one welcome-back prompt', () => {
    const { coordinator, presenter } = setup();
    coordinator.requestIdle(100);

    coordinator.beginMachineAway();
    expect(coordinator.get()).toEqual({ kind: 'NONE' });
    expect(presenter.hide).toHaveBeenCalledTimes(1);

    expect(coordinator.requestAway({ larkTaskGuid: null, stoppedAt: 200, reason: 'suspend' })).toBe(true);
    expect(coordinator.get()).toMatchObject({ kind: 'AWAY', reason: 'suspend' });
  });

  it('keeps one permission identity while changing intent or presentation', () => {
    const { coordinator, presenter } = setup();
    const first = coordinator.requestPermission('SETUP');
    if (first.kind !== 'PERMISSION') throw new Error('expected permission prompt');

    expect(coordinator.yieldPermissionToSystemSettings(first.promptId)).toBe(true);
    expect(coordinator.get()).toMatchObject({ presentation: 'YIELDED_TO_SETTINGS' });
    expect(presenter.yieldToSystemSettings).toHaveBeenCalledTimes(1);

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
