import type { TrackingCommandResult } from '../../shared/tracking';
import { broadcast } from '../broadcast';
import { sendHeartbeatNow } from './heartbeat';
import { getTimerService } from './timer';
import { getTrackingAttentionCoordinator } from './trackingAttention';
import { isTrackingBlockedError } from './trackingReadiness';
import { getTrackingReadinessService } from './trackingReadiness';

type PendingCommand =
  | { kind: 'START'; larkTaskGuid: string | null }
  | { kind: 'RESUME' };

let pending: PendingCommand | null = null;
let startupPromptOffered = false;

async function execute(command: PendingCommand): Promise<TrackingCommandResult> {
  try {
    const timer = getTimerService();
    const status = command.kind === 'START'
      ? await timer.start({ larkTaskGuid: command.larkTaskGuid })
      : await timer.resume();
    pending = null;
    broadcast('timer:status:push', status);
    sendHeartbeatNow();
    return { ok: true, status };
  } catch (error) {
    if (!isTrackingBlockedError(error)) throw error;
    pending = command;
    const status = getTimerService().status();
    getTrackingAttentionCoordinator().requestPermission(command.kind === 'START' ? 'START_TASK' : 'RESUME_ENTRY');
    return {
      ok: false,
      reason: 'PERMISSIONS_REQUIRED',
      status,
      readiness: error.readiness,
    };
  }
}

export function startTracking(larkTaskGuid?: string | null): Promise<TrackingCommandResult> {
  return execute({ kind: 'START', larkTaskGuid: larkTaskGuid ?? null });
}

export function resumeTracking(): Promise<TrackingCommandResult> {
  return execute({ kind: 'RESUME' });
}

export function retryPendingTrackingCommand(): Promise<TrackingCommandResult | null> {
  return pending ? execute(pending) : Promise.resolve(null);
}

export function offerPermissionResume(): void {
  pending = { kind: 'RESUME' };
  getTrackingAttentionCoordinator().requestPermission('RESUME_ENTRY');
}

export function offerPermissionStart(larkTaskGuid: string | null): void {
  pending = { kind: 'START', larkTaskGuid };
  getTrackingAttentionCoordinator().requestPermission('START_TASK');
}

export function clearPendingTrackingCommand(): void {
  pending = null;
}

export async function offerPermissionSetupOnStartup(): Promise<void> {
  if (startupPromptOffered) return;
  startupPromptOffered = true;
  const { readiness } = await getTrackingReadinessService().inspect({ verifyScreen: true });
  if (!readiness.ready) getTrackingAttentionCoordinator().requestPermission('SETUP');
}

export function resetPermissionSetupOffer(): void {
  startupPromptOffered = false;
  pending = null;
  const coordinator = getTrackingAttentionCoordinator();
  if (coordinator.isPermissionActive()) coordinator.clear();
}
