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
  onVisibilityReturn?: () => void;
  onReturnFromAway?: (info: AwayReturn) => void;
  onAwayStart?: () => void;
  onReturnComplete?: () => void;
}): void {
  const shutdownMonitor = powerMonitor as typeof powerMonitor & {
    on(event: 'shutdown', listener: (event: { preventDefault(): void }) => void): typeof powerMonitor;
  };

  type AwaySession = {
    info: { larkTaskGuid: string | null; awayStartedAt: number; reason: TimerAwayReason } | null;
    preparation: Promise<boolean>;
  };
  let awaySession: AwaySession | null = null;
  let returning: Promise<void> | null = null;
  let lastWakeAt = 0;

  const prepare = async (reason: TimerAwayReason, awayStartedAt: number): Promise<boolean> => {
    try {
      const timer = getTimerService();
      await timer.prepareForAway(reason, awayStartedAt);
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
    const awayStartedAt = Date.now();
    const before = getTimerService().status();
    opts.onAwayStart?.();
    awaySession = {
      info: before.state === 'RUNNING'
        ? { larkTaskGuid: before.larkTaskGuid, awayStartedAt, reason }
        : null,
      preparation: prepare(reason, awayStartedAt),
    };
  };

  const markBack = (): void => {
    if (returning) return;
    const now = Date.now();
    if (!awaySession && now - lastWakeAt < 1_000) return;
    lastWakeAt = now;
    const session = awaySession;
    returning = (async () => {
      opts.onWake();
      let prepared = session ? await session.preparation : true;
      if (!prepared && session?.info) {
        prepared = await prepare(session.info.reason, session.info.awayStartedAt);
      }
      if (prepared && session?.info) {
        opts.onReturnFromAway?.({
          larkTaskGuid: session.info.larkTaskGuid,
          stoppedAt: session.info.awayStartedAt,
          reason: session.info.reason,
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
