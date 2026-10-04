import type { TimerService } from './timerService';

export type TimerSyncDrainReason = 'interval' | 'auth' | 'heartbeat' | 'wake' | 'manual' | 'boot';

export const DEFAULT_TIMER_SYNC_DRAIN_INTERVAL_MS = 60_000;

/**
 * A pass that stopped at its batch limit may chain into another one, but only
 * so many times. Correct callers converge long before this; the cap exists so
 * that a `flushUnsynced` which never reports an empty backlog degrades into a
 * slow retry instead of a hot loop that starves everything else on the tick.
 * 20 passes x 25 entries clears 500 rows per burst, which is far more backlog
 * than a real client accumulates.
 */
export const MAX_CHAINED_DRAIN_PASSES = 20;

/**
 * Chained passes wait a beat instead of using setImmediate. Each pass is up to
 * 25 awaited round-trips, and running those back-to-back on the event loop is
 * what let the runaway loop crowd out the heartbeat and interval drains.
 */
export const CHAINED_DRAIN_DELAY_MS = 250;

export interface TimerSyncDrainLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface TimerSyncDrainDeps {
  timer: Pick<TimerService, 'flushUnsynced'>;
  isOnline?: () => boolean;
  intervalMs?: number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  logger?: TimerSyncDrainLogger;
}

export class TimerSyncDrain {
  private readonly intervalMs: number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly logger?: TimerSyncDrainLogger;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly deps: TimerSyncDrainDeps) {
    this.intervalMs = deps.intervalMs ?? DEFAULT_TIMER_SYNC_DRAIN_INTERVAL_MS;
    this.setIntervalFn = deps.setInterval ?? setInterval;
    this.clearIntervalFn = deps.clearInterval ?? clearInterval;
    this.logger = deps.logger;
  }

  start(): void {
    if (this.timer) return;
    this.timer = this.setIntervalFn(() => void this.drainNow('interval'), this.intervalMs);
    this.logger?.debug('timer sync drain started', { intervalMs: this.intervalMs });
  }

  stop(): void {
    if (!this.timer) return;
    this.clearIntervalFn(this.timer);
    this.timer = null;
    this.logger?.debug('timer sync drain stopped');
  }

  drainNow(reason: TimerSyncDrainReason, pass = 1): Promise<void> {
    if (reason === 'interval' && this.isDefinitelyOffline()) {
      this.logger?.debug('timer sync drain skipped offline', { reason });
      return Promise.resolve();
    }
    if (this.inFlight) {
      this.logger?.debug('timer sync drain already running', { reason });
      return this.inFlight;
    }
    this.inFlight = this.deps.timer
      .flushUnsynced()
      .then((moreRemaining) => {
        this.logger?.debug('timer sync drain finished', { reason, moreRemaining: moreRemaining === true });
        if (moreRemaining !== true) return;
        // flushUnsynced is bounded per call so it can't wedge the app behind a
        // long backlog. Keep going rather than waiting a full interval — but
        // bounded, and off the immediate tick, so a backlog that never reports
        // itself empty cannot hold the in-flight slot forever.
        if (pass >= MAX_CHAINED_DRAIN_PASSES) {
          this.logger?.warn('timer sync drain still reports a backlog; leaving it to the interval', {
            reason,
            passes: pass,
          });
          return;
        }
        setTimeout(() => void this.drainNow(reason, pass + 1), CHAINED_DRAIN_DELAY_MS);
      })
      .catch((err) => {
        this.logger?.warn('timer sync drain failed', { reason, err: String(err) });
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private isDefinitelyOffline(): boolean {
    try {
      return this.deps.isOnline?.() === false;
    } catch {
      return false;
    }
  }
}
