import { ipcMain } from 'electron';
import type {
  AttentionAction,
  AttentionActionResult,
  AttentionPrompt,
} from '../../shared/attention';
import { getTimerService } from '../services/timer';
import { getTrackingAttentionCoordinator } from '../services/trackingAttention';
import {
  clearPendingTrackingCommand,
  retryPendingTrackingCommand,
  resumeTracking,
  startTracking,
  stopTracking,
} from '../services/trackingCommands';
import { getTrackingReadinessService } from '../services/trackingReadiness';
import { refreshUpdateInstallability } from '../services/updates';

function allowed(kind: AttentionPrompt['kind'], action: AttentionAction): boolean {
  if (kind === 'IDLE_WARNING') return action === 'IDLE_WARNING_CONTINUE';
  if (kind === 'IDLE') return action === 'IDLE_CONTINUE' || action === 'IDLE_BREAK';
  if (kind === 'AWAY') return action === 'AWAY_RESUME' || action === 'AWAY_DISMISS';
  if (kind === 'PERMISSION') return action === 'PERMISSION_RETRY' || action === 'PERMISSION_CLOSE';
  return false;
}

export function registerAttentionIpc(): void {
  const coordinator = getTrackingAttentionCoordinator();
  ipcMain.handle('attention:get', (): AttentionPrompt => coordinator.get());
  ipcMain.handle('attention:yieldToSystemSettings', (_event, promptId: string) => ({
    // Standing down for System Settings is a suspension, not a hand-off: the
    // prompt comes back on its own once both capabilities are ready. Without
    // this predicate the user granted the permission and the prompt stayed
    // stranded behind Settings until they happened to click the tray.
    ok: coordinator.yieldPermissionToSystemSettings(promptId, {
      resumeWhen: async () => {
        const { readiness } = await getTrackingReadinessService().inspect({ verifyScreen: true });
        return readiness.ready;
      },
    }),
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

      // Clearing an idle prompt — here or by any other path — also tells the
      // idle monitor it was answered; main/index.ts listens for that.
      if (prompt.kind === 'IDLE_WARNING') {
        coordinator.clear(prompt.promptId);
        return { ok: true };
      }

      // A prompt can outlive the state it was asked about: the timer may have
      // been resumed, started or stopped somewhere else since. Answering it
      // must never act on a timer that is no longer the one it described.
      const timer = getTimerService().status();

      if (prompt.kind === 'IDLE') {
        if (timer.state !== 'RUNNING' || !timer.paused) {
          coordinator.clear(prompt.promptId);
          return { ok: true, command: { ok: true, status: timer } };
        }
        const command = input.action === 'IDLE_CONTINUE'
          ? await resumeTracking()
          : { ok: true as const, status: await stopTracking() };
        if (command.ok) coordinator.clear(prompt.promptId);
        refreshUpdateInstallability();
        return { ok: true, command };
      }

      if (prompt.kind === 'AWAY') {
        if (input.action === 'AWAY_DISMISS') {
          coordinator.clear(prompt.promptId);
          return { ok: true };
        }
        // Already tracking again: resuming the old task would switch away
        // from whatever the person chose since.
        if (timer.state === 'RUNNING') {
          coordinator.clear(prompt.promptId);
          return { ok: true, command: { ok: true, status: timer } };
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
