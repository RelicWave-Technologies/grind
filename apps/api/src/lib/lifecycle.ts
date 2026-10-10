import type { Server } from 'node:http';
import { logger } from '../logger';

/**
 * Process lifecycle: graceful shutdown on SIGTERM / SIGINT.
 *
 * A deploy stops the container with SIGTERM. Before this, nothing listened, so
 * the process died mid-request: an agent's checkpoint or a manager's approval
 * was cut off half-way, and a scheduler tick could be killed between two
 * writes. Now, on the first signal:
 *
 *   1. registered stop hooks run (schedulers stop starting new ticks);
 *   2. the HTTP server stops accepting connections and lets in-flight requests
 *      finish (keep-alive sockets are closed as soon as they go idle);
 *   3. after `timeoutMs`, anything still open is cut so a hung request cannot
 *      hold the deploy hostage;
 *   4. the database client disconnects and the process exits 0.
 *
 * Schedulers register a stop with {@link onShutdown}. One that has not yet is
 * still ended by the exit; registering just lets it stop between ticks.
 */

type StopHook = () => void | Promise<void>;

const hooks: StopHook[] = [];
let shuttingDown = false;

/** Register something to stop when the process shuts down. */
export function onShutdown(hook: StopHook): void {
  hooks.push(hook);
}

/** True once a shutdown has begun — long loops can check it and bail early. */
export function isShuttingDown(): boolean {
  return shuttingDown;
}

export interface GracefulShutdownDeps {
  server: Pick<Server, 'close'> & Partial<Pick<Server, 'closeIdleConnections' | 'closeAllConnections'>>;
  disconnect: () => Promise<void>;
  exit?: (code: number) => void;
  timeoutMs?: number;
  /** Extra hooks for this shutdown only (tests); registered hooks always run. */
  hooks?: StopHook[];
}

/** Run one shutdown. Resolves once the process has been told to exit. */
export async function shutdownGracefully(signal: string, deps: GracefulShutdownDeps): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = deps.timeoutMs ?? 25_000;
  logger.info({ signal }, 'shutting down: draining requests');

  for (const hook of [...hooks, ...(deps.hooks ?? [])]) {
    try {
      await hook();
    } catch (err) {
      logger.warn({ err: String(err) }, 'shutdown hook failed');
    }
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(sweep);
      resolve();
    };
    const timer = setTimeout(() => {
      logger.warn({ timeoutMs }, 'shutdown: in-flight requests did not finish in time; closing them');
      deps.server.closeAllConnections?.();
      done();
    }, timeoutMs);
    timer.unref?.();
    deps.server.close(() => done());
    // A keep-alive socket goes idle the moment its last request finishes, but
    // close() only drops the ones idle right now. Keep sweeping so a finished
    // connection does not hold the shutdown until the keep-alive timeout.
    deps.server.closeIdleConnections?.();
    const sweep = setInterval(() => deps.server.closeIdleConnections?.(), 100);
    sweep.unref?.();
  });

  try {
    await deps.disconnect();
  } catch (err) {
    logger.warn({ err: String(err) }, 'shutdown: database disconnect failed');
  }
  logger.info('shutdown complete');
  exit(0);
}

/** Wire SIGTERM and SIGINT to {@link shutdownGracefully}. */
export function installGracefulShutdown(deps: GracefulShutdownDeps): void {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void shutdownGracefully(signal, deps);
    });
  }
}

/** Test seam: forget that a shutdown happened and drop registered hooks. */
export function _resetLifecycleForTests(): void {
  shuttingDown = false;
  hooks.length = 0;
}
