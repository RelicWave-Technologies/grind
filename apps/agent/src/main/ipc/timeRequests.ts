import { ipcMain } from 'electron';
import { ulid } from 'ulid';
import { api } from '../services/apiClient';
import { log } from '../logger';

export type ManualTimeRequestDto = {
  id: string;
  clientUuid: string;
  userId: string;
  approverId: string | null;
  larkTaskGuid: string | null;
  larkMessageId: string | null;
  requestedStart: string;
  requestedEnd: string;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  decidedAt: string | null;
  decidedReason: string | null;
  createdAt: string;
};

export type CreateManualTimeRequestInput = {
  requestedStart: number; // epoch ms
  requestedEnd: number; // epoch ms
  reason: string;
  larkTaskGuid?: string | null;
  taskSummary?: string | null;
};

/**
 * Agent IPC for the "Request manual time" flow (M10). The backend owns the
 * decision pipeline (approver pick + Lark card delivery); the agent just
 * collects user intent and POSTs.
 *
 * `clientUuid` is generated here so retries from the renderer never create
 * duplicates — the backend route is idempotent on this key.
 */
export function registerTimeRequestsIpc(): void {
  ipcMain.handle(
    'timeRequests:create',
    async (
      _e,
      input: CreateManualTimeRequestInput,
    ): Promise<{ ok: boolean; request?: ManualTimeRequestDto; error?: string }> => {
      try {
        const body = {
          clientUuid: ulid(),
          requestedStart: new Date(input.requestedStart).toISOString(),
          requestedEnd: new Date(input.requestedEnd).toISOString(),
          reason: input.reason,
          larkTaskGuid: input.larkTaskGuid ?? null,
          taskSummary: input.taskSummary ?? null,
        };
        const request = await api<ManualTimeRequestDto>('/v1/time-requests', { method: 'POST', body });
        return { ok: true, request };
      } catch (err) {
        const msg = String(err);
        log.warn('timeRequests:create failed', { err: msg });
        // Surface "no admin to approve" + range errors plainly so the UI can show them.
        if (msg.includes('400')) return { ok: false, error: 'invalid_range_or_no_approver' };
        if (msg.includes('409')) return { ok: false, error: 'duplicate' };
        return { ok: false, error: msg };
      }
    },
  );

  ipcMain.handle(
    'timeRequests:listMine',
    async (
      _e,
      status?: 'PENDING' | 'APPROVED' | 'REJECTED',
    ): Promise<{ requests: ManualTimeRequestDto[] }> => {
      try {
        const q = new URLSearchParams({ role: 'mine' });
        if (status) q.set('status', status);
        return await api<{ requests: ManualTimeRequestDto[] }>(`/v1/time-requests?${q.toString()}`);
      } catch (err) {
        log.warn('timeRequests:listMine failed', { err: String(err) });
        return { requests: [] };
      }
    },
  );
}
