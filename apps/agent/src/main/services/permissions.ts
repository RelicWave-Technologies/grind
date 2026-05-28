import { systemPreferences } from 'electron';

export type ScreenStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';

/** Outcome of the most recent capture attempt — distinguishes "no permission"
 *  from "granted but producing blank frames" (the mid-session revocation tell). */
export type CaptureHealth = 'ok' | 'no-permission' | 'empty' | 'error' | 'unknown';

/** What the UI should tell the user about screen-recording permission. */
export type ScreenUiState = 'ok' | 'needs-grant' | 'needs-settings' | 'needs-restart';

/**
 * Screen Recording permission status (macOS). On other platforms screen capture
 * needs no permission, so we report 'granted'. Uses Electron's built-in
 * systemPreferences (no native module / Linux build issues).
 *
 * NOTE: `getMediaAccessStatus('screen')` can return a STALE value after the user
 * toggles the permission (electron#36722) until the app restarts — which is also
 * required for screen capture to actually start working. The `needs-restart`
 * UI state + relaunch flow handle this.
 */
export function screenStatus(): ScreenStatus {
  if (process.platform !== 'darwin') return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('screen') as ScreenStatus;
  } catch {
    return 'unknown';
  }
}

export function hasScreenAccess(): boolean {
  return screenStatus() === 'granted';
}

/**
 * Pure decision: given the reported status and the last capture outcome, what
 * should the UI show? Crucially:
 *  - status granted but captures come back empty/error  → 'needs-restart'
 *    (covers both "granted, not yet effective (needs relaunch)" and
 *     "revoked mid-session" — both are fixed by a relaunch / re-grant).
 *  - never asked                                        → 'needs-grant'
 *  - denied / restricted                                → 'needs-settings'
 */
export function screenUiState(status: ScreenStatus, health: CaptureHealth): ScreenUiState {
  if (status === 'granted') {
    return health === 'empty' || health === 'error' ? 'needs-restart' : 'ok';
  }
  if (status === 'not-determined' || status === 'unknown') return 'needs-grant';
  return 'needs-settings'; // denied | restricted
}
