import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, X, Clock, AlertTriangle, Sparkles } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { ManualTimeRequest, DecideResult, MtrStatus } from '../lib/types';
import { fmtTime, fmtDurationMs, fmtDayLabel, fmtAgeShort } from '../lib/format';

const STUCK_THRESHOLD_MS = 48 * 60 * 60 * 1000;

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
  const [stuckOnly, setStuckOnly] = useState(false);
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ['admin', 'mtr', tab],
    queryFn: () => api<ListResponse>(`/v1/admin/manual-time-requests?status=${tab}`),
  });

  // Client-side stuck filter + age sort. The list endpoint already
  // returns createdAt — we don't ask the server to paginate by age
  // because manager queues are small (≤ ~50 rows in practice).
  const visible = useMemo(() => {
    if (!q.data) return [];
    const now = Date.now();
    let rows = q.data.requests;
    if (tab === 'PENDING' && stuckOnly) {
      rows = rows.filter((r) => now - new Date(r.createdAt).getTime() >= STUCK_THRESHOLD_MS);
    }
    if (tab === 'PENDING') {
      // Oldest first — stuck items rise to the top of the queue.
      rows = [...rows].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    }
    return rows;
  }, [q.data, tab, stuckOnly]);

  const stuckCount = useMemo(() => {
    if (!q.data || tab !== 'PENDING') return 0;
    const now = Date.now();
    return q.data.requests.filter((r) => now - new Date(r.createdAt).getTime() >= STUCK_THRESHOLD_MS).length;
  }, [q.data, tab]);

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

        <div className="day-controls">
          {tab === 'PENDING' && (
            <button
              type="button"
              className={`btn-ghost stuck-toggle${stuckOnly ? ' is-active' : ''}`}
              onClick={() => setStuckOnly((v) => !v)}
              disabled={stuckCount === 0 && !stuckOnly}
              title={`${stuckCount} pending request${stuckCount === 1 ? '' : 's'} have been waiting ≥48h`}
            >
              <AlertTriangle size={13} strokeWidth={2.2} />
              <span>{stuckOnly ? 'Showing stuck' : 'Stuck only'}</span>
              {stuckCount > 0 && <span className="stuck-count">{stuckCount}</span>}
            </button>
          )}
          <div className="tabs">
            {(['PENDING', 'APPROVED', 'REJECTED'] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={`tab${t === tab ? ' is-active' : ''}`}
                onClick={() => {
                  setTab(t);
                  if (t !== 'PENDING') setStuckOnly(false);
                }}
              >
                {TAB_LABEL[t]}
              </button>
            ))}
          </div>
        </div>
      </header>

      {q.isLoading && <div className="card empty">Loading…</div>}
      {q.isError && (
        <div className="card empty empty-error">
          Couldn&apos;t load: {(q.error as Error).message}
        </div>
      )}

      {q.data && visible.length === 0 && (
        <div className="card empty">
          {tab === 'PENDING'
            ? stuckOnly
              ? 'No stuck approvals — everything pending is fresh.'
              : 'No requests waiting on you. Nice work.'
            : `No ${tab.toLowerCase()} requests in scope.`}
        </div>
      )}

      {q.data && visible.length > 0 && (
        <div className="approvals-list">
          {visible.map((r) => (
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
  const ageMs = Date.now() - new Date(req.createdAt).getTime();
  const isStuck = isPending && ageMs >= STUCK_THRESHOLD_MS;

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

        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {isPending && (
            <span
              className={`age-chip${isStuck ? ' is-stuck' : ''}`}
              title={`Submitted ${new Date(req.createdAt).toLocaleString()}`}
            >
              {isStuck && <AlertTriangle size={10} strokeWidth={2.4} />}
              {fmtAgeShort(ageMs)}
            </span>
          )}
          <div className={`status-pill status-${req.status.toLowerCase()}`}>
            {req.status === 'PENDING' && <Clock size={11} strokeWidth={2.2} />}
            {req.status === 'APPROVED' && <Check size={11} strokeWidth={2.2} />}
            {req.status === 'REJECTED' && <X size={11} strokeWidth={2.2} />}
            <span>{req.status}</span>
          </div>
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

      {req.triage && isPending && <TriageBadge triage={req.triage} />}

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

function TriageBadge({ triage }: { triage: NonNullable<ManualTimeRequest['triage']> }) {
  const verdictClass =
    triage.verdict === 'approve' ? 'triage-approve' : triage.verdict === 'reject' ? 'triage-reject' : 'triage-review';
  const verdictLabel =
    triage.verdict === 'approve' ? 'Likely safe' : triage.verdict === 'reject' ? 'Worth pushing back' : 'Take a look';
  const confidencePct = Math.round(triage.confidence * 100);
  return (
    <div className={`triage-badge ${verdictClass}`} role="note" aria-label="AI triage suggestion">
      <div className="triage-head">
        <Sparkles size={11} strokeWidth={2.4} aria-hidden />
        <span className="triage-label">{verdictLabel}</span>
        <span className="triage-confidence" title={`${confidencePct}% confidence`}>
          {confidencePct}%
        </span>
      </div>
      <ul className="triage-signals" role="list">
        {triage.signals.slice(0, 3).map((s) => (
          <li key={s.id} className={s.weight >= 0 ? 'triage-sig-pos' : 'triage-sig-neg'}>
            {s.text}
          </li>
        ))}
      </ul>
    </div>
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
