import type { TimerRecoveryNotice } from './agent.d';

export function timerRecoveryNoticeText(notice: TimerRecoveryNotice, fmtTime: (ts: number) => string): string {
  const at = fmtTime(notice.recoveredAt);
  if (notice.reason === 'sleep_stop') return `Timo stopped tracking when your computer went to sleep at ${at}.`;
  if (notice.reason === 'lock_stop') return `Timo stopped tracking when your screen locked at ${at}.`;
  if (notice.reason === 'server_finalized') return `Timo stopped this timer at ${at} because the server had already finalized it.`;
  // Never blame the device clock: the server moves an end for reasons other
  // than a fast clock, and only says that it moved it.
  if (notice.reason === 'server_clock_corrected') return `Timo adjusted this timer's end to the server's time (${at}).`;
  return `Timo recovered a timer from an unexpected shutdown and stopped it at ${at}.`;
}
