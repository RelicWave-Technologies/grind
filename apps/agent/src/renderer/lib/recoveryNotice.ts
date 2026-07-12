import type { TimerRecoveryNotice } from './agent.d';

export function defaultTimeOfDay(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function timerRecoveryNoticeText(notice: TimerRecoveryNotice, fmtTime: (ts: number) => string = defaultTimeOfDay): string {
  const at = fmtTime(notice.recoveredAt);
  if (notice.reason === 'sleep_stop') return `Timo stopped tracking when your computer went to sleep at ${at}.`;
  if (notice.reason === 'lock_stop') return `Timo stopped tracking when your screen locked at ${at}.`;
  if (notice.reason === 'server_finalized') return `Timo stopped this timer at ${at} because the server had already finalized it.`;
  return `Timo recovered a timer from an unexpected shutdown and stopped it at ${at}.`;
}
