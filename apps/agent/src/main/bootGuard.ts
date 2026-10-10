/**
 * Guards for the part of boot that runs before Timo has any UI.
 *
 * A throw there used to escape the whole `whenReady` handler into the
 * unhandled-rejection log before the tray or window existed. The process kept
 * the single-instance lock, so every later launch only flagged "show the
 * window when ready" — an invisible Timo that could not be reopened. Each
 * pre-UI step is now isolated (like boot.ts's steps), and when no UI at all
 * could be built the app exits so the lock is released.
 */
export interface BootGuardLogger {
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Run one pre-UI boot step; a throw is logged and reads as `undefined`. */
export function guardBootStep<T>(logger: BootGuardLogger, name: string, run: () => T): T | undefined {
  try {
    return run();
  } catch (err) {
    logger.error(`boot: ${name} failed`, {
      err: String(err),
      stack: err instanceof Error ? err.stack ?? null : null,
    });
    return undefined;
  }
}

/**
 * Either the tray or the main window is enough to carry on: the tray reopens
 * the window, and the window (plus the Dock on macOS) is the app. With
 * neither, nothing can be reached and the process only holds the lock.
 */
export function uiBootOutcome(ui: { hasTray: boolean; hasWindow: boolean }): 'ready' | 'exit' {
  return ui.hasTray || ui.hasWindow ? 'ready' : 'exit';
}
