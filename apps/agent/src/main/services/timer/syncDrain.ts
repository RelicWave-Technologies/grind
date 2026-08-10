import type { TimerService } from './timerService';

export type TimerSyncDrainReason = 'interval' | 'auth' | 'heartbeat' | 'wake' | 'manual' | 'boot';

export const DEFAULT_TIMER_SYNC_DRAIN_INTERVAL_MS = 60_000;

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

  drainNow(reason: TimerSyncDrainReason): Promise<void> {
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
        // flushUnsynced is bounded per call so it can't wedge the app behind a
        // long backlog. Keep going on the next tick of the event loop rather
        // than waiting a full interval — a backlog should still clear promptly.
        if (moreRemaining === true) setImmediate(() => void this.drainNow(reason));
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
