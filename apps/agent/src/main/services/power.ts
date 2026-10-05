import { app, powerMonitor } from 'electron';
import { getTimerService } from './timer';
import { runQuitCleanup } from './quitCleanup';
import { broadcast } from '../broadcast';
import { log } from '../logger';
import type { TimerAwayReason } from './timer/types';

/** What the machine was doing + tracking when the user stepped away. */
export type AwayReturn = { larkTaskGuid: string | null; stoppedAt: number; reason: TimerAwayReason };

/** System idle at least this long when the machine goes away is not billed. */
export const AWAY_IDLE_BACKDATE_MIN_SEC = 30;

/** How far before the lock/sleep the person actually stopped working. */
export function idleBeforeAwayMs(systemIdleSec: number): number {
  if (!Number.isFinite(systemIdleSec) || systemIdleSec < AWAY_IDLE_BACKDATE_MIN_SEC) return 0;
  return systemIdleSec * 1000;
}

/**
 * Wires OS power/lock events to the timer so sleep/lock gaps are never billed.
 * Going away (lock OR suspend) stops any active timer at the away boundary;
 * coming back fires `onWake` (re-assert float + retry sync) and, if a running
 * timer was stopped by the away, `onReturnFromAway` so the caller can offer to
 * resume.
 */
export function registerPowerEvents(opts: {
  onWake: () => void;
  onVisibilityReturn?: () => void;
  onReturnFromAway?: (info: AwayReturn) => void;
  onAwayStart?: () => void;
  onReturnComplete?: () => void;
}): void {
  const shutdownMonitor = powerMonitor as typeof powerMonitor & {
    on(event: 'shutdown', listener: (event: { preventDefault(): void }) => void): typeof powerMonitor;
  };

  type AwaySession = {
    reason: TimerAwayReason;
    awayStartedAt: number;
    /** A timer was open, so the away had something to close. */
    timerWasOpen: boolean;
    /** What to offer on return — only for a timer that was accruing. */
    resume: { larkTaskGuid: string | null } | null;
    preparation: Promise<boolean>;
  };
  let awaySession: AwaySession | null = null;
  let returning: Promise<void> | null = null;
  let lastWakeAt = 0;

  const prepare = async (reason: TimerAwayReason, awayStartedAt: number): Promise<boolean> => {
    try {
      const timer = getTimerService();
      // Hand over elapsed time, never an instant. `awayStartedAt` is a device
      // clock reading and the timer runs on the server-aligned clock; the two
      // are not comparable, but the gap between two device readings is.
      // eslint-disable-next-line no-restricted-syntax -- device<->device: the GAP is handed to the timer, never the instant
      await timer.prepareForAway(reason, Math.max(0, Date.now() - awayStartedAt));
      broadcast('timer:status:push', timer.status());
      log.info('timer stopped for machine away', { reason, awayStartedAt });
      return true;
    } catch (err) {
      log.warn('prepareForAway failed', { reason, awayStartedAt, err: String(err) });
      return false;
    }
  };

  const markAway = (reason: TimerAwayReason) => {
    if (awaySession) return;
    // An auto-lock follows a stretch of no input, and that stretch was not
    // work either: the person left before the screen locked. Move the away
    // boundary back to when input stopped. Short gaps are ordinary pauses
    // between keystrokes and stay counted.
    const idleMs = idleBeforeAwayMs(powerMonitor.getSystemIdleTime());
    // eslint-disable-next-line no-restricted-syntax -- device<->device: only ever subtracted from a later Date.now()
    const awayStartedAt = Date.now() - idleMs;
    const before = getTimerService().status();
    opts.onAwayStart?.();
    awaySession = {
      reason,
      awayStartedAt,
      timerWasOpen: before.state === 'RUNNING',
      // Offer to resume only a timer that was accruing. A paused one already
      // stopped counting earlier, so "stopped at <lock time>" would be wrong
      // and the person never asked for it to run again.
      resume: before.state === 'RUNNING' && !before.paused
        ? { larkTaskGuid: before.larkTaskGuid }
        : null,
      preparation: prepare(reason, awayStartedAt),
    };
  };

  const markBack = (): void => {
    if (returning) return;
    // eslint-disable-next-line no-restricted-syntax -- device<->device: wake de-duplication window against lastWakeAt
    const now = Date.now();
    if (!awaySession && now - lastWakeAt < 1_000) return;
    lastWakeAt = now;
    const session = awaySession;
    returning = (async () => {
      opts.onWake();
      let prepared = session ? await session.preparation : true;
      if (!prepared && session?.timerWasOpen) {
        prepared = await prepare(session.reason, session.awayStartedAt);
      }
      if (prepared && session?.resume) {
        opts.onReturnFromAway?.({
          larkTaskGuid: session.resume.larkTaskGuid,
          stoppedAt: session.awayStartedAt,
          reason: session.reason,
        });
      }
      awaySession = null;
      opts.onReturnComplete?.();
    })().finally(() => {
      returning = null;
    });
  };

  powerMonitor.on('suspend', () => markAway('suspend'));
  powerMonitor.on('lock-screen', () => markAway('lock'));
  powerMonitor.on('resume', () => markBack());
  powerMonitor.on('unlock-screen', () => {
    markBack();
    opts.onVisibilityReturn?.();
  });
  shutdownMonitor.on('shutdown', (event: { preventDefault(): void }) => {
    event.preventDefault();
    log.info('system shutdown cleanup requested');
    void runQuitCleanup('shutdown').finally(() => app.quit());
  });
}
