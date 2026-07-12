import type { MoveToApplicationsResult } from '../../shared/launchAtLogin';

export interface MoveToApplicationsDeps {
  isTracking: () => boolean;
  confirm: () => Promise<boolean>;
  cleanup: () => Promise<void>;
  move: () => boolean;
  invalidateCleanup: () => void;
}

export async function moveToApplications(
  deps: MoveToApplicationsDeps,
): Promise<MoveToApplicationsResult> {
  if (deps.isTracking()) return { ok: false, reason: 'TRACKING_ACTIVE' };
  if (!(await deps.confirm())) return { ok: false, reason: 'CANCELLED' };

  await deps.cleanup();
  try {
    if (deps.move()) return { ok: true };
    deps.invalidateCleanup();
    return { ok: false, reason: 'CANCELLED' };
  } catch {
    deps.invalidateCleanup();
    return { ok: false, reason: 'MOVE_FAILED' };
  }
}
