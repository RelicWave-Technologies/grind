import type { CapabilityState } from './tracking';

export type PermissionCapability = 'screen' | 'accessibility';

/**
 * A permission "Restart Timo" pressed just before this process started: the
 * verdict it was pressed for, and when (device clock — only ever compared with
 * this machine's next boot).
 */
export interface PermissionRelaunchRecord {
  /** `capability:state` for every capability that was not ready, e.g. "screen:FAILED". */
  verdict: string[];
  relaunchedAt: number;
}

export function permissionVerdictToken(capability: PermissionCapability, state: CapabilityState): string {
  return `${capability}:${state}`;
}

/**
 * The restart was already tried for exactly this verdict and it came straight
 * back: another restart will not fix it. Older Macs (11/12) in particular keep
 * a stale Screen Recording / Accessibility entry for a replaced binary, and
 * only removing Timo from the list and adding it again clears that.
 */
export function restartDidNotHelp(
  record: PermissionRelaunchRecord | null | undefined,
  capability: PermissionCapability,
  state: CapabilityState,
): boolean {
  if (!record) return false;
  if (state === 'READY' || state === 'NOT_REQUIRED' || state === 'CHECKING') return false;
  return record.verdict.includes(permissionVerdictToken(capability, state));
}
