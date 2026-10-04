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
/**
 * macOS 15 (Sequoia) re-asks. Any app that captures the screen now gets a
 * recurring TCC prompt — weekly at 15.0, relaxed to roughly monthly from 15.1 —
 * whether or not ScreenCaptureKit is used. If the user dismisses or denies it,
 * capture returns blank frames exactly like a manual revocation, which is why
 * the monitor requires several consecutive unhealthy checks (plus an idle test)
 * before pausing tracking. Suppressing the prompt needs
 * com.apple.developer.persistent-content-capture, a managed entitlement Apple
 * neither documents nor offers a public request form for.
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
 * Accessibility trust (macOS) — required for the global keyboard & mouse hook.
 *
 * This checks Accessibility (kTCCServiceAccessibility) specifically, which is
 * the right gate for how libuiohook works: it creates an ACTIVE tap
 * (kCGEventTapOptionDefault) and gates itself on AXIsProcessTrustedWithOptions.
 *
 * Do not assume it covers Input Monitoring. kTCCServiceAccessibility,
 * kTCCServiceListenEvent (Input Monitoring) and kTCCServicePostEvent are three
 * independent TCC rows, and Accessibility does not imply Input Monitoring.
 * Electron exposes no API for the Input Monitoring row, so when a machine does
 * demand it the only signal is uIOhook.start() failing while
 * isTrustedAccessibilityClient() still says true — surfaced as FAILED (not
 * NEEDS_RESTART), with UI copy naming Input Monitoring, because relaunching
 * cannot supply a grant.
 *
 * Windows and Linux need no equivalent grant. One known Windows limitation: a
 * non-elevated process receives no input events while a UAC-elevated window is
 * focused, so counts under-report for admin apps. Fixing that would mean
 * running Timo elevated, which we will not do.
 *
 * Original note — Accessibility / Input Monitoring trust — required for global keyboard & mouse
 * counting via uiohook (uIOhook.start() crashes without it). `prompt=true` shows
 * the system dialog. Non-macOS platforms don't gate this.
 */
export function hasAccessibilityAccess(prompt = false): boolean {
  if (process.platform !== 'darwin') return true;
  try {
    return systemPreferences.isTrustedAccessibilityClient(prompt);
  } catch {
    return false;
  }
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
