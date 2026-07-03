import { app, powerMonitor } from 'electron';
import { getTimerService } from './timer';
import { runQuitCleanup } from './quitCleanup';
import { broadcast } from '../broadcast';
import { log } from '../logger';

/**
 * Wires OS power/lock events to the timer so sleep/lock gaps are never billed.
 * Going away stops any active timer at the away boundary; coming back only
 * fires `onWake` so callers can re-assert always-on-top state and retry sync.
 */
export function registerPowerEvents(opts: { onWake: () => void }): void {
  const shutdownMonitor = powerMonitor as typeof powerMonitor & {
    on(event: 'shutdown', listener: (event: { preventDefault(): void }) => void): typeof powerMonitor;
  };

  const markAway = async (reason: 'suspend' | 'lock') => {
    const awayStartedAt = Date.now();
    try {
      const timer = getTimerService();
      await timer.prepareForAway(reason, awayStartedAt);
      broadcast('timer:status:push', timer.status());
      log.info('timer stopped for machine away', { reason, awayStartedAt });
    } catch (err) {
      log.warn('prepareForAway failed', { reason, err: String(err) });
    }
  };

  const markBack = () => {
    opts.onWake();
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
