export type TaskTimerState = 'idle' | 'tracking' | 'paused';
export type TaskTimerAction = 'start' | 'stop' | 'resume';

export function taskTimerState(input: { running: boolean; paused?: boolean }): TaskTimerState {
  if (!input.running) return 'idle';
  return input.paused ? 'paused' : 'tracking';
}

export function taskTimerAction(state: TaskTimerState): TaskTimerAction {
  if (state === 'tracking') return 'stop';
  if (state === 'paused') return 'resume';
  return 'start';
}

export function taskTimerLabel(state: TaskTimerState): 'Tracking' | 'Paused' | null {
  if (state === 'tracking') return 'Tracking';
  if (state === 'paused') return 'Paused';
  return null;
}
