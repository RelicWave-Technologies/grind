import type { CapabilityState } from '../../shared/tracking';

/**
 * What a permission row tells the user, and which button it offers — shared by
 * the permission prompt and Settings so the two can never disagree.
 *
 * Pure so it can be tested: this is the copy a blocked user reads, and getting
 * it wrong sends them round a loop that cannot resolve their problem.
 */
export type Capability = 'screen' | 'accessibility';
/** `check-again` re-verifies in place and comes with an Open Settings link. */
export type PermissionAction = 'enable' | 'settings' | 'check-again';

export function isReady(state: CapabilityState): boolean {
  return state === 'READY' || state === 'NOT_REQUIRED';
}

export function actionFor(state: CapabilityState): PermissionAction | null {
  // Still resolving: offering any button here is how the relaunch loop started.
  if (state === 'CHECKING') return null;
  if (state === 'NEEDS_GRANT') return 'enable';
  if (state === 'NEEDS_SETTINGS') return 'settings';
  // Granted, yet not working: a screen whose probes stay blank, or an input
  // hook macOS refused. Check again re-probes the screen and retries the hook.
  if (state === 'FAILED') return 'check-again';
  return null;
}

/**
 * Whether to add a plain "Restart Timo" link beside the row's own action. Only
 * as a fallback, never first:
 *  - FAILED, once Check again has run and the verdict still stands;
 *  - Screen Recording still not granted after the user came back from System
 *    Settings — macOS can keep reporting a grant made while Timo runs as
 *    missing until the app relaunches (electron#36722).
 * Never for CHECKING: a granted-but-blank screen is not fixed by a restart.
 */
export function offersRestart(
  state: CapabilityState,
  capability: Capability,
  context: { checkedAgain: boolean; returnedFromSettings: boolean },
): boolean {
  if (state === 'FAILED') return context.checkedAgain;
  if (capability === 'screen' && (state === 'NEEDS_GRANT' || state === 'NEEDS_SETTINGS')) {
    return context.returnedFromSettings;
  }
  return false;
}

export function statusText(state: CapabilityState, capability: Capability): string {
  if (state === 'READY' || state === 'NOT_REQUIRED') return 'Ready';
  if (state === 'CHECKING') return 'Checking…';
  if (state === 'NEEDS_GRANT') return 'Permission required';
  if (state === 'NEEDS_SETTINGS') return 'Enable in System Settings';
  // libuiohook's event tap is gated on Accessibility trust. When macOS says
  // trusted but refuses the tap, the trust entry is stale (typically after an
  // update replaced the binary); toggling it off and on re-issues it.
  return capability === 'accessibility'
    ? 'Not responding — turn Timo off and on under Accessibility'
    : 'Not capturing yet — check System Settings';
}

export function actionLabel(action: PermissionAction): string {
  if (action === 'enable') return 'Enable';
  if (action === 'check-again') return 'Check again';
  return 'Open Settings';
}

export const RESTART_LABEL = 'Restart Timo';
