import type { CapabilityState } from '../../shared/tracking';

/**
 * What the permission prompt tells the user, and which button it offers.
 *
 * Pure so it can be tested: this is the copy a blocked user reads, and getting
 * it wrong sends them round a loop that cannot resolve their problem.
 */
export type Capability = 'screen' | 'accessibility';
export type PermissionAction = 'enable' | 'settings' | 'restart' | 'input-monitoring';

export function isReady(state: CapabilityState): boolean {
  return state === 'READY' || state === 'NOT_REQUIRED';
}

export function actionFor(state: CapabilityState, capability: Capability): PermissionAction | null {
  if (state === 'NEEDS_GRANT') return 'enable';
  if (state === 'NEEDS_SETTINGS') return 'settings';
  // FAILED on the input hook means macOS refused the event tap even though
  // Accessibility is trusted — the missing grant is Input Monitoring, a
  // separate TCC service (kTCCServiceListenEvent) with no prompt API.
  // Relaunching cannot supply it, so send the user to that pane instead.
  if (state === 'FAILED' && capability === 'accessibility') return 'input-monitoring';
  if (state === 'NEEDS_RESTART' || state === 'FAILED') return 'restart';
  return null;
}

export function statusText(state: CapabilityState, capability: Capability): string {
  if (state === 'READY' || state === 'NOT_REQUIRED') return 'Ready';
  if (state === 'NEEDS_GRANT') return 'Permission required';
  if (state === 'NEEDS_SETTINGS') return 'Enable in System Settings';
  if (state === 'NEEDS_RESTART') return 'Restart Timo to apply';
  return capability === 'accessibility'
    ? 'Also allow Timo under Input Monitoring'
    : 'Permission service needs restart';
}
