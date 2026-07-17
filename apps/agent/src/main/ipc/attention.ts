import { ipcMain } from 'electron';
import type {
  AttentionAction,
  AttentionActionResult,
  AttentionPrompt,
} from '../../shared/attention';
import { broadcast } from '../broadcast';
import { sendHeartbeatNow } from '../services/heartbeat';
import { getTimerService } from '../services/timer';
import { getTrackingAttentionCoordinator } from '../services/trackingAttention';
import {
  clearPendingTrackingCommand,
  retryPendingTrackingCommand,
  resumeTracking,
  startTracking,
} from '../services/trackingCommands';
import { refreshUpdateInstallability } from '../services/updates';

interface AttentionIpcOptions {
  onIdleResolved: () => void;
}

function allowed(kind: AttentionPrompt['kind'], action: AttentionAction): boolean {
  if (kind === 'IDLE_WARNING') return action === 'IDLE_WARNING_CONTINUE';
  if (kind === 'IDLE') return action === 'IDLE_CONTINUE' || action === 'IDLE_BREAK';
  if (kind === 'AWAY') return action === 'AWAY_RESUME' || action === 'AWAY_DISMISS';
  if (kind === 'PERMISSION') return action === 'PERMISSION_RETRY' || action === 'PERMISSION_CLOSE';
  return false;
}

export function registerAttentionIpc(opts: AttentionIpcOptions): void {
  const coordinator = getTrackingAttentionCoordinator();
  ipcMain.handle('attention:get', (): AttentionPrompt => coordinator.get());
  ipcMain.handle('attention:yieldToSystemSettings', (_event, promptId: string) => ({
    ok: coordinator.yieldPermissionToSystemSettings(promptId),
  }));
  ipcMain.handle(
    'attention:resolve',
    async (_event, input: { promptId: string; action: AttentionAction }): Promise<AttentionActionResult> => {
      if (!input || typeof input.promptId !== 'string' || typeof input.action !== 'string') {
        return { ok: false, reason: 'ACTION_NOT_ALLOWED' };
      }
      const prompt = coordinator.get();
      if (prompt.kind === 'NONE' || prompt.promptId !== input.promptId) {
        return { ok: false, reason: 'STALE_PROMPT' };
      }
      if (!allowed(prompt.kind, input.action)) return { ok: false, reason: 'ACTION_NOT_ALLOWED' };

      if (prompt.kind === 'IDLE_WARNING') {
        opts.onIdleResolved();
        coordinator.clear(prompt.promptId);
        return { ok: true };
      }

      if (prompt.kind === 'IDLE') {
        const command = input.action === 'IDLE_CONTINUE'
          ? await resumeTracking()
          : { ok: true as const, status: await getTimerService().stop() };
        opts.onIdleResolved();
        if (command.ok) coordinator.clear(prompt.promptId);
        if (input.action === 'IDLE_BREAK') {
          broadcast('timer:status:push', command.status);
          sendHeartbeatNow();
        }
        refreshUpdateInstallability();
        return { ok: true, command };
      }

      if (prompt.kind === 'AWAY') {
        if (input.action === 'AWAY_DISMISS') {
          coordinator.clear(prompt.promptId);
          return { ok: true };
        }
        const command = await startTracking(prompt.larkTaskGuid);
        if (command.ok) coordinator.clear(prompt.promptId);
        return { ok: true, command };
      }

      if (input.action === 'PERMISSION_CLOSE') {
        clearPendingTrackingCommand();
        coordinator.clear(prompt.promptId);
        return { ok: true };
      }
      const command = await retryPendingTrackingCommand();
      if (!command || command.ok) coordinator.clear(prompt.promptId);
      return { ok: true, command };
    },
  );
}
