/** Which question the "Ready to work?" toast is currently asking. */
export type ShiftPromptReason =
  /** The user's shift just opened. */
  | 'SHIFT_START'
  /** Mid-shift: active at the machine for a while with no timer running. */
  | 'UNTRACKED';

export interface TodayShiftWindow {
  name: string;
  start: string;
  end: string;
  startedAt: number;
  endedAt: number;
}
