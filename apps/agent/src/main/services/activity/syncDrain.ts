import type { ActivityStore } from './store';

export type ActivitySyncDrainReason = 'boot' | 'auth' | 'heartbeat' | 'wake' | 'periodic' | 'sample' | 'manual';

export const DEFAULT_ACTIVITY_SYNC_DRAIN_INTERVAL_MS = 5 * 60_000;
export const HEARTBEAT_ACTIVITY_DRAIN_THROTTLE_MS = 60_000;
export const ACTIVITY_SYNC_DRAIN_MAX_BATCHES = 10;

export interface ActivitySyncDrainLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface ActivitySyncDrainDeps {
  getStore: () => ActivityStore;
  flush: (store: ActivityStore) => Promise<number>;
  intervalMs?: number;
  heartbeatThrottleMs?: number;
  maxBatches?: number;
  now?: () => number;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  logger?: ActivitySyncDrainLogger;
}

export interface ActivitySyncDrainResult {
  batches: number;
  samples: number;
  skipped: 'heartbeat-throttle' | null;
}

/** Drains the local activity outbox even when no new minute arrives. */
export class ActivitySyncDrain {
  private readonly intervalMs: number;
  private readonly heartbeatThrottleMs: number;
  private readonly maxBatches: number;
  private readonly now: () => number;
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private readonly logger?: ActivitySyncDrainLogger;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<ActivitySyncDrainResult> | null = null;
  private lastHeartbeatDrainAt = 0;

  constructor(private readonly deps: ActivitySyncDrainDeps) {
    this.intervalMs = deps.intervalMs ?? DEFAULT_ACTIVITY_SYNC_DRAIN_INTERVAL_MS;
    this.heartbeatThrottleMs = deps.heartbeatThrottleMs ?? HEARTBEAT_ACTIVITY_DRAIN_THROTTLE_MS;
    this.maxBatches = deps.maxBatches ?? ACTIVITY_SYNC_DRAIN_MAX_BATCHES;
    this.now = deps.now ?? Date.now;
    this.setIntervalFn = deps.setInterval ?? setInterval;
    this.clearIntervalFn = deps.clearInterval ?? clearInterval;
    this.logger = deps.logger;
  }

  start(): void {
    if (this.timer) return;
    this.timer = this.setIntervalFn(() => void this.drainNow('periodic'), this.intervalMs);
    this.logger?.debug('activity sync drain started', { intervalMs: this.intervalMs });
  }

  stop(): void {
    if (!this.timer) return;
    this.clearIntervalFn(this.timer);
    this.timer = null;
    this.logger?.debug('activity sync drain stopped');
  }

  drainNow(reason: ActivitySyncDrainReason): Promise<ActivitySyncDrainResult> {
    if (reason === 'heartbeat') {
      const now = this.now();
      if (now - this.lastHeartbeatDrainAt < this.heartbeatThrottleMs) {
        this.logger?.debug('activity sync drain heartbeat throttled', { reason });
        return Promise.resolve({ batches: 0, samples: 0, skipped: 'heartbeat-throttle' });
      }
      this.lastHeartbeatDrainAt = now;
    }

    if (this.inFlight) {
      this.logger?.debug('activity sync drain already running', { reason });
      return this.inFlight;
    }

    this.inFlight = this.run(reason).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async run(reason: ActivitySyncDrainReason): Promise<ActivitySyncDrainResult> {
    let batches = 0;
    let samples = 0;
    for (let i = 0; i < this.maxBatches; i += 1) {
      try {
        const flushed = await this.deps.flush(this.deps.getStore());
        if (flushed <= 0) break;
        batches += 1;
        samples += flushed;
      } catch (err) {
        this.logger?.warn('activity sync drain failed', { reason, batches, samples, err: String(err) });
        break;
      }
    }
    this.logger?.debug('activity sync drain finished', { reason, batches, samples });
    return { batches, samples, skipped: null };
  }
}
