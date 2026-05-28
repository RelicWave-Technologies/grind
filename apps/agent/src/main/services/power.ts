import { powerMonitor } from 'electron';
import { getTimerService } from './timer';
import { log } from '../logger';

/**
 * Wires OS power/lock events to the timer so sleep/lock gaps are never billed:
 * capture when the machine goes away, and on return trim that gap from the
 * running entry (TimerService.discardAway). Also fires `onWake` so callers can
 * re-assert always-on-top state for the floating bar.
 */
export function registerPowerEvents(opts: { onWake: () => void }): void {
  let awayStart: number | null = null;

  const markAway = (reason: string) => {
    if (awayStart === null) {
      awayStart = Date.now();
      log.info('machine away', { reason });
    }
  };

  const markBack = async (reason: string) => {
    const start = awayStart;
    awayStart = null;
    if (start !== null) {
      try {
        await getTimerService().discardAway(start, Date.now());
        log.info('trimmed away gap', { reason, awayMs: Date.now() - start });
      } catch (err) {
        log.warn('discardAway failed', { err: String(err) });
      }
    }
    opts.onWake();
  };

  powerMonitor.on('suspend', () => markAway('suspend'));
  powerMonitor.on('lock-screen', () => markAway('lock'));
  powerMonitor.on('resume', () => void markBack('resume'));
  powerMonitor.on('unlock-screen', () => void markBack('unlock'));
}
