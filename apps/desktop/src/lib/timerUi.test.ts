import { describe, expect, it } from 'vitest';
import { taskTimerAction, taskTimerLabel, taskTimerState } from './timerUi';

describe('task timer UI decisions', () => {
  it('maps idle tasks to start with no status label', () => {
    const state = taskTimerState({ running: false });
    expect(state).toBe('idle');
    expect(taskTimerAction(state)).toBe('start');
    expect(taskTimerLabel(state)).toBeNull();
  });

  it('maps active running tasks to tracking + stop', () => {
    const state = taskTimerState({ running: true, paused: false });
    expect(state).toBe('tracking');
    expect(taskTimerAction(state)).toBe('stop');
    expect(taskTimerLabel(state)).toBe('Tracking');
  });

  it('maps paused running tasks to paused + resume', () => {
    const state = taskTimerState({ running: true, paused: true });
    expect(state).toBe('paused');
    expect(taskTimerAction(state)).toBe('resume');
    expect(taskTimerLabel(state)).toBe('Paused');
  });
});
