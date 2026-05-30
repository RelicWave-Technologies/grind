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
      status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED',
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

  /** Edit a still-PENDING request. Server returns 409 once it's decided. */
  ipcMain.handle(
    'timeRequests:patch',
    async (
      _e,
      args: {
        id: string;
        requestedStart?: number;
        requestedEnd?: number;
        larkTaskGuid?: string | null;
        taskSummary?: string | null;
        reason?: string;
      },
    ): Promise<{ ok: boolean; request?: ManualTimeRequestDto; error?: string }> => {
      try {
        const body: Record<string, unknown> = {};
        if (args.requestedStart !== undefined) body.requestedStart = new Date(args.requestedStart).toISOString();
        if (args.requestedEnd !== undefined) body.requestedEnd = new Date(args.requestedEnd).toISOString();
        if (args.larkTaskGuid !== undefined) body.larkTaskGuid = args.larkTaskGuid;
        if (args.taskSummary !== undefined) body.taskSummary = args.taskSummary;
        if (args.reason !== undefined) body.reason = args.reason;
        const request = await api<ManualTimeRequestDto>(`/v1/time-requests/${args.id}`, { method: 'PATCH', body });
        return { ok: true, request };
      } catch (err) {
        const msg = String(err);
        log.warn('timeRequests:patch failed', { err: msg, id: args.id });
        if (msg.includes('409')) return { ok: false, error: 'already_decided' };
        if (msg.includes('403')) return { ok: false, error: 'forbidden' };
        if (msg.includes('404')) return { ok: false, error: 'not_found' };
        return { ok: false, error: msg };
      }
    },
  );

  /** Cancel a still-PENDING request. Server returns 409 once it's decided. */
  ipcMain.handle(
    'timeRequests:cancel',
    async (_e, id: string): Promise<{ ok: boolean; request?: ManualTimeRequestDto; error?: string }> => {
      try {
        const request = await api<ManualTimeRequestDto>(`/v1/time-requests/${id}/cancel`, { method: 'POST' });
        return { ok: true, request };
      } catch (err) {
        const msg = String(err);
        log.warn('timeRequests:cancel failed', { err: msg, id });
        if (msg.includes('409')) return { ok: false, error: 'already_decided' };
        return { ok: false, error: msg };
      }
    },
  );
}
