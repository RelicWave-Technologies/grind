import { app, powerMonitor } from 'electron';
import { getTimerService } from './timer';
import { runQuitCleanup } from './quitCleanup';
import { broadcast } from '../broadcast';
import { log } from '../logger';
import type { TimerAwayReason } from './timer/types';

/** What the machine was doing + tracking when the user stepped away. */
export type AwayReturn = { larkTaskGuid: string | null; stoppedAt: number; reason: TimerAwayReason };

/**
 * Wires OS power/lock events to the timer so sleep/lock gaps are never billed.
 * Going away (lock OR suspend) stops any active timer at the away boundary;
 * coming back fires `onWake` (re-assert float + retry sync) and, if a running
 * timer was stopped by the away, `onReturnFromAway` so the caller can offer to
 * resume.
 */
export function registerPowerEvents(opts: {
  onWake: () => void;
  onReturnFromAway?: (info: AwayReturn) => void;
}): void {
  const shutdownMonitor = powerMonitor as typeof powerMonitor & {
    on(event: 'shutdown', listener: (event: { preventDefault(): void }) => void): typeof powerMonitor;
  };

  // Set when a RUNNING timer is stopped by lock/suspend; consumed on the next
  // resume/unlock. First away wins (sleep can fire both lock + suspend).
  let pendingAway: { larkTaskGuid: string | null; awayStartedAt: number; reason: TimerAwayReason } | null = null;

  const markAway = async (reason: TimerAwayReason) => {
    const awayStartedAt = Date.now();
    try {
      const timer = getTimerService();
      const before = timer.status();
      if (before.state === 'RUNNING' && !pendingAway) {
        pendingAway = { larkTaskGuid: before.larkTaskGuid, awayStartedAt, reason };
      }
      await timer.prepareForAway(reason, awayStartedAt);
      broadcast('timer:status:push', timer.status());
      log.info('timer stopped for machine away', { reason, awayStartedAt });
    } catch (err) {
      log.warn('prepareForAway failed', { reason, err: String(err) });
    }
  };

  const markBack = () => {
    opts.onWake();
    const away = pendingAway;
    pendingAway = null;
    // Always offer to resume when a running timer was stopped by the away —
    // regardless of how long it was tracked or how long the machine was away.
    if (away) {
      opts.onReturnFromAway?.({ larkTaskGuid: away.larkTaskGuid, stoppedAt: away.awayStartedAt, reason: away.reason });
    }
  };

  powerMonitor.on('suspend', () => void markAway('suspend'));
  powerMonitor.on('lock-screen', () => void markAway('lock'));
  powerMonitor.on('resume', () => markBack());
  powerMonitor.on('unlock-screen', () => markBack());
  shutdownMonitor.on('shutdown', (event: { preventDefault(): void }) => {
    event.preventDefault();
    log.info('system shutdown cleanup requested');
    void runQuitCleanup('shutdown').finally(() => app.quit());
  });
}
