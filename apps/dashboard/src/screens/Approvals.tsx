import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, X, Clock } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { ManualTimeRequest, DecideResult, MtrStatus } from '../lib/types';
import { fmtTime, fmtDurationMs, fmtDayLabel } from '../lib/format';

interface ListResponse {
  requests: ManualTimeRequest[];
  scope: 'self' | 'team' | 'workspace';
}

const SCOPE_LABEL: Record<ListResponse['scope'], string> = {
  self: 'Just you',
  team: 'Your team',
  workspace: 'Entire workspace',
};

const TAB_LABEL: Record<'PENDING' | 'APPROVED' | 'REJECTED', string> = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
};

/**
 * Manager/admin queue of ManualTimeRequest decisions. Mirror of the Lark
 * IM card flow — same DB writes, plus a best-effort card refresh from the
 * server side so the chat history stays in sync.
 *
 * Defaults to Pending; toggle filters at the top.
 */
export function ApprovalsScreen() {
  const [tab, setTab] = useState<'PENDING' | 'APPROVED' | 'REJECTED'>('PENDING');
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ['admin', 'mtr', tab],
    queryFn: () => api<ListResponse>(`/v1/admin/manual-time-requests?status=${tab}`),
  });

  const decide = useMutation({
    mutationFn: async (vars: { id: string; action: 'approve' | 'reject'; reason?: string }) => {
      return api<DecideResult>(`/v1/admin/manual-time-requests/${vars.id}/decide`, {
        method: 'POST',
        json: { action: vars.action, reason: vars.reason },
      });
    },
    onSuccess: () => {
      // Both the source tab AND the destination tab change — invalidate
      // every status bucket so a freshly-decided row vanishes from
      // pending and shows up in approved/rejected next time it's opened.
      qc.invalidateQueries({ queryKey: ['admin', 'mtr'] });
    },
  });

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1 className="h1">Approvals</h1>
          <p className="secondary page-sub">
            {q.data ? <span className="scope-chip">{SCOPE_LABEL[q.data.scope]}</span> : <span>Loading scope…</span>}
          </p>
        </div>

        <div className="tabs">
          {(['PENDING', 'APPROVED', 'REJECTED'] as const).map((t) => (
            <button
              key={t}
              type="button"
              className={`tab${t === tab ? ' is-active' : ''}`}
              onClick={() => setTab(t)}
            >
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
      </header>

      {q.isLoading && <div className="card empty">Loading…</div>}
      {q.isError && (
        <div className="card empty empty-error">
          Couldn&apos;t load: {(q.error as Error).message}
        </div>
      )}

      {q.data && q.data.requests.length === 0 && (
        <div className="card empty">
          {tab === 'PENDING' ? 'No requests waiting on you. Nice work.' : `No ${tab.toLowerCase()} requests in scope.`}
        </div>
      )}

      {q.data && q.data.requests.length > 0 && (
        <div className="approvals-list">
          {q.data.requests.map((r) => (
            <ApprovalCard
              key={r.id}
              req={r}
              busy={decide.isPending && decide.variables?.id === r.id}
              decidedError={
                decide.isError && decide.variables?.id === r.id
                  ? (decide.error as Error | ApiError).message
                  : null
              }
              onApprove={() => decide.mutate({ id: r.id, action: 'approve' })}
              onReject={(reason) => decide.mutate({ id: r.id, action: 'reject', reason })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface CardProps {
  req: ManualTimeRequest;
  busy: boolean;
  decidedError: string | null;
  onApprove: () => void;
  onReject: (reason: string) => void;
}

function ApprovalCard({ req, busy, decidedError, onApprove, onReject }: CardProps) {
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');

  const startMs = new Date(req.requestedStart).getTime();
  const endMs = new Date(req.requestedEnd).getTime();
  const dayLabel = fmtDayLabel(req.requestedStart.slice(0, 10));
  const isPending = req.status === 'PENDING';

  return (
    <article className={`approval-card status-${req.status.toLowerCase()}`}>
      <div className="approval-head">
        <div className="approval-who">
          <div className="avatar-sm" aria-hidden>
            {initials(req.user.name)}
          </div>
          <div className="approval-meta">
            <div className="approval-name">{req.user.name}</div>
            <div className="approval-email small secondary">{req.user.email}</div>
          </div>
        </div>

        <div className={`status-pill status-${req.status.toLowerCase()}`}>
          {req.status === 'PENDING' && <Clock size={11} strokeWidth={2.2} />}
          {req.status === 'APPROVED' && <Check size={11} strokeWidth={2.2} />}
          {req.status === 'REJECTED' && <X size={11} strokeWidth={2.2} />}
          <span>{req.status}</span>
        </div>
      </div>

      <div className="approval-body">
        <div className="approval-row">
          <span className="approval-label">Time</span>
          <span className="approval-value tabular">
            {dayLabel} · {fmtTime(startMs)} – {fmtTime(endMs)}{' '}
            <span className="secondary">({fmtDurationMs(endMs - startMs)})</span>
          </span>
        </div>
        <div className="approval-row">
          <span className="approval-label">Reason</span>
          <span className="approval-value">{req.reason}</span>
        </div>
        {req.larkTaskGuid && (
          <div className="approval-row">
            <span className="approval-label">Task</span>
            <span className="approval-value secondary">{req.larkTaskGuid}</span>
          </div>
        )}
        {req.decidedReason && (
          <div className="approval-row">
            <span className="approval-label">Reviewer note</span>
            <span className="approval-value">{req.decidedReason}</span>
          </div>
        )}
      </div>

      {decidedError && <div className="approval-error">Failed: {decidedError}</div>}

      {isPending && (
        <div className="approval-actions">
          {rejecting ? (
            <form
              className="reject-form"
              onSubmit={(e) => {
                e.preventDefault();
                onReject(reason.trim() || 'No reason given');
              }}
            >
              <input
                type="text"
                autoFocus
                placeholder="Why? (optional, shown to the requester)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
              />
              <button type="button" className="btn-ghost" onClick={() => setRejecting(false)} disabled={busy}>
                Cancel
              </button>
              <button type="submit" className="btn-danger" disabled={busy}>
                {busy ? 'Rejecting…' : 'Confirm reject'}
              </button>
            </form>
          ) : (
            <>
              <button type="button" className="btn-ghost" onClick={() => setRejecting(true)} disabled={busy}>
                <X size={14} strokeWidth={2} />
                <span>Reject</span>
              </button>
              <button type="button" className="btn-primary" onClick={onApprove} disabled={busy}>
                <Check size={14} strokeWidth={2.2} />
                <span>{busy ? 'Approving…' : 'Approve'}</span>
              </button>
            </>
          )}
        </div>
      )}
    </article>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

// Suppress unused-type warning for an enum we re-export indirectly.
export type { MtrStatus };
