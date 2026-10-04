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

/** Worked time as the timer shows it everywhere: HH:MM:SS, or MM:SS under an hour. */
export function fmtClock(ms: number): string {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}
