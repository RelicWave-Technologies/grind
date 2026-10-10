import type { DesktopPermissionSnapshot } from '@grind/types';

/**
 * The User columns a heartbeat's permission snapshot is stored in.
 *
 * The raw snapshot alone reads as healthy for an input hook macOS refused:
 * trusted, ready, and — once tracking is paused for it — not recording, which
 * the dashboard showed as "Access OK". Newer agents also send their own
 * readiness verdict; it is folded into the existing columns rather than new
 * ones:
 *  - accessibility FAILED (trusted, but the hook / activity service would not
 *    start) is stored as trusted-but-not-ready, which the dashboard shows as
 *    blocked. On Windows this is how a hook that will not start shows up.
 *  - screen FAILED is never stored as 'ok'; 'needs-restart' is the wire name
 *    for "granted but not capturing".
 * Older agents send no verdict and are stored exactly as before.
 */
export function agentPermissionColumns(permissions: DesktopPermissionSnapshot) {
  const verdict = permissions.verdict;
  const screenFailed = verdict?.screenRecording === 'FAILED';
  const accessibilityFailed = verdict?.accessibility === 'FAILED';
  return {
    agentScreenPermissionStatus: permissions.screen.status,
    agentScreenCaptureHealth: permissions.screen.health,
    agentScreenPermissionState: screenFailed && permissions.screen.state === 'ok'
      ? 'needs-restart'
      : permissions.screen.state,
    agentAccessibilityTrusted: permissions.accessibility.trusted,
    agentAccessibilityReady: permissions.accessibility.ready && !accessibilityFailed,
    agentAccessibilityRecording: permissions.accessibility.recording,
    agentAccessibilityCapturing: permissions.accessibility.capturing,
    agentAccessibilityHookRunning: permissions.accessibility.hookRunning,
  };
}
