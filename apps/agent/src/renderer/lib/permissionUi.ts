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
export type PermissionAction = 'enable' | 'settings' | 'restart' | 'input-monitoring' | 'check-again';

export function isReady(state: CapabilityState): boolean {
  return state === 'READY' || state === 'NOT_REQUIRED';
}

/**
 * @param restartDidNotHelp the same verdict already stood before a restart a
 *   moment ago — offering another one is how a relaunch loop starts.
 */
export function actionFor(state: CapabilityState, capability: Capability, restartDidNotHelp = false): PermissionAction | null {
  // Still resolving: offering any button here is how the relaunch loop started.
  if (state === 'CHECKING') return null;
  if (state === 'NEEDS_GRANT') return 'enable';
  if (state === 'NEEDS_SETTINGS') return 'settings';
  // FAILED on the input hook means macOS refused the event tap even though
  // Accessibility is trusted — the missing grant is Input Monitoring, a
  // separate TCC service (kTCCServiceListenEvent) with no prompt API.
  // Relaunching cannot supply it, so send the user to that pane instead.
  if (state === 'FAILED' && capability === 'accessibility') return 'input-monitoring';
  // FAILED on the screen means granted but every probe stays blank. The grant
  // is already effective in this process, so a restart cannot help either.
  if (state === 'FAILED') return 'check-again';
  if (state === 'NEEDS_RESTART') return restartDidNotHelp ? 'check-again' : 'restart';
  return null;
}

export function statusText(state: CapabilityState, capability: Capability, restartDidNotHelp = false): string {
  if (state === 'READY' || state === 'NOT_REQUIRED') return 'Ready';
  if (state === 'CHECKING') return 'Checking…';
  if (state === 'NEEDS_GRANT') return 'Permission required';
  if (state === 'NEEDS_SETTINGS') return 'Enable in System Settings';
  if (state === 'NEEDS_RESTART') return restartDidNotHelp ? 'Still not ready after restart' : 'Restart Timo to apply';
  return capability === 'accessibility'
    ? 'Also allow Timo under Input Monitoring'
    : 'Not capturing yet — check System Settings';
}

export function actionLabel(action: PermissionAction): string {
  if (action === 'enable') return 'Enable';
  if (action === 'restart') return 'Restart';
  if (action === 'check-again') return 'Check again';
  return 'Open Settings';
}
