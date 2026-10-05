import { flushPartialActivity } from './activity';
import { flushPreferences } from './preferences';
import { getTimerService } from './timer';
import type { TimerExitReason } from './timer/types';
import { flushLogs, log } from '../logger';

const QUIT_CLEANUP_TIMEOUT_MS = 5_000;

type TimerForQuit = {
  prepareForQuit(reason: TimerExitReason): Promise<unknown>;
  /** `limit` is optional so quit can drain the WHOLE backlog, not one batch. */
  flushUnsynced(limit?: number): Promise<unknown>;
};

type QuitCleanupLogger = Pick<typeof log, 'debug' | 'warn'>;

export interface QuitCleanupDeps {
  getTimer: () => TimerForQuit;
  flushPartialActivity: () => void;
  flushPreferences: () => Promise<unknown> | unknown;
  flushLogs?: () => Promise<unknown> | unknown;
  logger?: QuitCleanupLogger;
  timeoutMs?: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

export interface BeforeQuitEventLike {
  preventDefault(): void;
}

export interface AppQuitLike {
  on(event: 'before-quit', listener: (event: BeforeQuitEventLike) => void): unknown;
  quit(): void;
}

export class QuitCleanupRunner {
  private inFlight: Promise<void> | null = null;
  private completed = false;
  private readonly logger: QuitCleanupLogger;
  private readonly timeoutMs: number;
  private readonly setTimer: typeof setTimeout;
  private readonly clearTimer: typeof clearTimeout;

  constructor(private readonly deps: QuitCleanupDeps) {
    this.logger = deps.logger ?? log;
    this.timeoutMs = deps.timeoutMs ?? QUIT_CLEANUP_TIMEOUT_MS;
    this.setTimer = deps.setTimeout ?? setTimeout;
    this.clearTimer = deps.clearTimeout ?? clearTimeout;
  }

  hasCompleted(): boolean {
    return this.completed;
  }

  invalidate(): void {
    this.completed = false;
  }

  run(reason: TimerExitReason): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.completed = false;
    this.inFlight = this.runOnce(reason)
      .then(() => {
        this.completed = true;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  private async runOnce(reason: TimerExitReason): Promise<void> {
    this.logger.debug('quit cleanup started', { reason });

    try {
      this.deps.flushPartialActivity();
    } catch (err) {
      this.logger.warn('quit cleanup activity failed', { reason, err: String(err) });
    }

    try {
      const timer = this.deps.getTimer();
      await this.withTimeout('timer finalization', timer.prepareForQuit(reason));
      // Quit must push everything it can, so bypass the per-pass batch limit —
      // the surrounding withTimeout is what bounds how long shutdown waits.
      await this.withTimeout('timer sync', timer.flushUnsynced(Number.POSITIVE_INFINITY));
    } catch (err) {
      this.logger.warn('quit cleanup timer failed', { reason, err: String(err) });
    }

    try {
      await this.withTimeout('preferences', Promise.resolve(this.deps.flushPreferences()));
    } catch (err) {
      this.logger.warn('quit cleanup preferences failed', { reason, err: String(err) });
    }

    this.logger.debug('quit cleanup finished', { reason });

    try {
      await this.withTimeout('logs', Promise.resolve(this.deps.flushLogs?.()));
    } catch {
      // Logging is best-effort and must never prevent a clean timer shutdown.
    }
  }

  private withTimeout<T>(label: string, task: Promise<T>): Promise<T | null> {
    let timer: NodeJS.Timeout | null = null;
    return Promise.race([
      task.then(
        (value) => {
          if (timer) this.clearTimer(timer);
          return value;
        },
        (err) => {
          if (timer) this.clearTimer(timer);
          throw err;
        },
      ),
      new Promise<null>((resolve) => {
        timer = this.setTimer(() => {
          this.logger.warn('quit cleanup timed out', { label, ms: this.timeoutMs });
          resolve(null);
        }, this.timeoutMs);
      }),
    ]);
  }
}

const defaultRunner = new QuitCleanupRunner({
  getTimer: () => getTimerService(),
  flushPartialActivity,
  flushPreferences,
  flushLogs,
  logger: log,
});

export function runQuitCleanup(reason: TimerExitReason): Promise<void> {
  return defaultRunner.run(reason);
}

export function hasQuitCleanupCompleted(): boolean {
  return defaultRunner.hasCompleted();
}

export function invalidateQuitCleanup(): void {
  defaultRunner.invalidate();
}

function timerIsRunning(): boolean {
  try {
    return getTimerService().isRunning();
  } catch {
    return false;
  }
}

/**
 * A finished cleanup only vouches for the timer as it was when it ran. The
 * update install runs it early and then waits for the installer to quit the
 * app; if the install fails, or the person starts tracking again meanwhile, a
 * "completed" flag would let the next Quit skip finalizing a running timer.
 */
function cleanupStillCovers(hasCompleted: () => boolean, isTimerRunning: () => boolean): boolean {
  return hasCompleted() && !isTimerRunning();
}

/**
 * Run the quit cleanup unless one already finished and still holds. For exit
 * paths that cannot wait (before-quit-for-update, Windows session end): the
 * timer close is written synchronously before the first await, so starting it
 * is what matters. Shares the in-flight run, so no path runs it twice.
 */
export function runQuitCleanupIfNeeded(
  reason: TimerExitReason,
  opts: { hasCleanupCompleted?: () => boolean; isTimerRunning?: () => boolean; runCleanup?: (reason: TimerExitReason) => Promise<void> } = {},
): Promise<void> {
  const hasCompleted = opts.hasCleanupCompleted ?? hasQuitCleanupCompleted;
  const isTimerRunning = opts.isTimerRunning ?? timerIsRunning;
  if (cleanupStillCovers(hasCompleted, isTimerRunning)) return Promise.resolve();
  return (opts.runCleanup ?? runQuitCleanup)(reason);
}

export function registerGracefulQuitHandler(opts: {
  app: AppQuitLike;
  runCleanup?: (reason: TimerExitReason) => Promise<void>;
  hasCleanupCompleted?: () => boolean;
  isTimerRunning?: () => boolean;
  markQuitting?: () => void;
}): void {
  const runCleanup = opts.runCleanup ?? runQuitCleanup;
  const hasCleanupCompleted = opts.hasCleanupCompleted ?? hasQuitCleanupCompleted;
  const isTimerRunning = opts.isTimerRunning ?? timerIsRunning;
  // The quit we re-issue after our own cleanup always goes through, even if
  // that cleanup could not stop the timer — otherwise Quit would loop.
  let reissuing = false;
  opts.app.on('before-quit', (event) => {
    opts.markQuitting?.();
    if (reissuing || cleanupStillCovers(hasCleanupCompleted, isTimerRunning)) return;
    event.preventDefault();
    void runCleanup('quit').finally(() => {
      reissuing = true;
      try {
        opts.app.quit();
      } finally {
        reissuing = false;
      }
    });
  });
}
