/**
 * Windows shutdown, restart, and sign-off.
 *
 * Electron's powerMonitor 'shutdown' (which power.ts uses to run the quit
 * cleanup) fires on macOS and Linux only. On Windows the session ends through
 * window messages instead: WM_QUERYENDSESSION asks every top-level window
 * whether it may end — another app can still veto it — and WM_ENDSESSION
 * (Electron's 'session-end') says it is ending, after which the process can be
 * killed at any moment. Without a hook a running timer was simply cut off and
 * left to boot recovery, which only trusts it up to the last liveness tick.
 *
 * So: on the query, write a fresh proof of life and change nothing else (the
 * shutdown may be cancelled, and tracking must carry on if it is). On the
 * end, run the quit cleanup. Its timer close is written synchronously before
 * its first await, so it lands even if Windows does not wait for the rest.
 */
export const WM_QUERYENDSESSION = 0x0011;

export interface SessionEndWindow {
  hookWindowMessage(message: number, callback: (wParam: Buffer, lParam: Buffer) => void): void;
  on(event: 'session-end', listener: () => void): unknown;
}

export interface SessionEndHandlers {
  /** The session may end soon. Must not stop anything. */
  onQueryEnd: () => void;
  /** The session is ending now. */
  onEnd: () => void;
}

/** @returns whether anything was attached (Windows only). */
export function attachWindowsSessionEnd(
  win: SessionEndWindow,
  handlers: SessionEndHandlers,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'win32') return false;
  win.hookWindowMessage(WM_QUERYENDSESSION, () => {
    try {
      handlers.onQueryEnd();
    } catch {
      // A failed proof of life must never delay the user's shutdown.
    }
  });
  win.on('session-end', () => {
    handlers.onEnd();
  });
  return true;
}
