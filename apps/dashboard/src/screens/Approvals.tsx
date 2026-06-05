import './approvals.css';
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, X, Sparkles, Inbox } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import type { ManualTimeRequest, DecideResult, MtrStatus } from '../lib/types';
import { fmtTime, fmtDurationMs, fmtDayLabel, fmtAgeShort } from '../lib/format';
import {
  Page,
  PageHeader,
  Card,
  Stat,
  StatRow,
  Tabs,
  Segmented,
  Toolbar,
  Identity,
  Avatar,
  Tag,
  Button,
  Banner,
  EmptyState,
  Skeleton,
} from '../ui';
import type { Status } from '../ui';

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

type TabValue = 'PENDING' | 'APPROVED' | 'REJECTED';

const TABS: ReadonlyArray<{ value: TabValue; label: string }> = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
];

/** Status taxonomy for a request's decision tag. */
const STATUS_TAG: Record<MtrStatus, Status> = {
  PENDING: 'warn',
  APPROVED: 'success',
  REJECTED: 'danger',
  CANCELLED: 'neutral',
};

/** Triage verdict → kit status taxonomy (approve safe, review caution, reject danger). */
const TRIAGE_STATUS: Record<NonNullable<ManualTimeRequest['triage']>['verdict'], Status> = {
  approve: 'success',
  review: 'warn',
  reject: 'danger',
};

/**
 * /approvals — manager/admin queue of ManualTimeRequest decisions, composed from
 * the shared "Quiet Datasheet" kit (SYSTEM.md). The PageHeader carries scope +
 * title + a live subline, with status Tabs docked on the rule and a stuck-only
 * Segmented in the toolbar. Pending shows a StatRow (Pending / Stuck). Each
 * request is a Card: requester Identity, a status Tag + age, a label/value time
 * block, the AI-triage read as a quiet note in its taxonomy colour, and the
 * approve / reject (inline reason) actions as kit Buttons. Stuck items (waiting
 * ≥48h) carry the warn taxonomy so they read at a glance.
 *
 * Mirror of the Lark IM card flow — same DB writes, plus a best-effort card
 * refresh server-side so chat history stays in sync. Defaults to Pending;
 * toggle filters in the header. Behaviour is unchanged — presentation only.
 */
export function ApprovalsScreen() {
  const [tab, setTab] = useState<TabValue>('PENDING');
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

  const subLine = q.data
    ? tab === 'PENDING'
      ? visible.length === 0
        ? 'Nothing waiting on you'
        : `${visible.length} awaiting review${stuckCount > 0 ? ` · ${stuckCount} stuck` : ''}`
      : `${visible.length} ${tab.toLowerCase()} in scope`
    : 'Loading the queue';

  const showStats = tab === 'PENDING' && !!q.data;

  return (
    <Page>
      <PageHeader
        eyebrow={`${q.data ? SCOPE_LABEL[q.data.scope] : 'Manual time'} · Review`}
        title="Approvals"
        subtitle={subLine}
        actions={
          tab === 'PENDING' ? (
            <Toolbar>
              <Segmented
                aria-label="Filter pending requests"
                value={stuckOnly ? 'stuck' : 'all'}
                onChange={(v) => setStuckOnly(v === 'stuck')}
                items={[
                  { value: 'all', label: 'All' },
                  { value: 'stuck', label: stuckCount > 0 ? `Stuck · ${stuckCount}` : 'Stuck' },
                ]}
              />
            </Toolbar>
          ) : undefined
        }
        tabs={
          <Tabs
            aria-label="Request status"
            value={tab}
            onChange={(t) => {
              setTab(t);
              if (t !== 'PENDING') setStuckOnly(false);
            }}
            items={TABS}
          />
        }
      />

      {showStats && (
        <Card variant="flush">
          <StatRow>
            <Stat label="Pending" value={visible.length} />
            <Stat label="Stuck ≥48h" value={stuckCount} hint="Waiting too long" />
          </StatRow>
        </Card>
      )}

      {q.isLoading && (
        <div className="apv-list">
          {[0, 1, 2].map((i) => (
            <Card key={i}>
              <div className="apv-skeleton">
                <Skeleton w={180} h={20} />
                <Skeleton w="60%" h={14} />
                <Skeleton w="40%" h={14} />
              </div>
            </Card>
          ))}
        </div>
      )}

      {q.isError && (
        <Banner status="danger">Couldn&apos;t load the queue — {(q.error as Error).message}</Banner>
      )}

      {q.data && visible.length === 0 && (
        <EmptyState
          icon={tab === 'PENDING' && !stuckOnly ? <Check size={22} strokeWidth={2} /> : <Inbox size={22} strokeWidth={1.8} />}
          title={
            tab === 'PENDING'
              ? stuckOnly
                ? 'Nothing stuck'
                : 'Queue is clear'
              : `No ${tab.toLowerCase()} requests`
          }
          description={
            tab === 'PENDING'
              ? stuckOnly
                ? 'Everything pending is still fresh — nothing has been waiting too long.'
                : 'No requests waiting on you right now. Nice work.'
              : `No ${tab.toLowerCase()} requests in scope.`
          }
        />
      )}

      {q.data && visible.length > 0 && (
        <div className="apv-list">
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
    </Page>
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
    <Card>
      <div className="apv-card">
        <div className="apv-head">
          <Identity
            name={req.user.name}
            subtitle={req.user.email}
            avatar={<Avatar name={req.user.name} size={40} />}
          />
          <div className="apv-head-end">
            {isPending && (
              <Tag status={isStuck ? 'warn' : 'neutral'} mono dot={!isStuck}>
                {fmtAgeShort(ageMs)}
              </Tag>
            )}
            <Tag status={STATUS_TAG[req.status]}>{req.status}</Tag>
          </div>
        </div>

        <dl className="apv-spec">
          <div className="apv-row">
            <dt className="apv-row__label ui-t-eyebrow">Time</dt>
            <dd className="apv-row__value">
              <span className="mono">
                {dayLabel} · {fmtTime(startMs)} – {fmtTime(endMs)}
              </span>
              <Tag mono>{fmtDurationMs(endMs - startMs)}</Tag>
            </dd>
          </div>
          <div className="apv-row">
            <dt className="apv-row__label ui-t-eyebrow">Reason</dt>
            <dd className="apv-row__value">{req.reason}</dd>
          </div>
          {req.larkTaskGuid && (
            <div className="apv-row">
              <dt className="apv-row__label ui-t-eyebrow">Task</dt>
              <dd className="apv-row__value mono">{req.larkTaskGuid}</dd>
            </div>
          )}
          {req.decidedReason && (
            <div className="apv-row">
              <dt className="apv-row__label ui-t-eyebrow">Reviewer</dt>
              <dd className="apv-row__value">{req.decidedReason}</dd>
            </div>
          )}
        </dl>

        {req.triage && isPending && <TriageNote triage={req.triage} />}

        {decidedError && <Banner status="danger">Failed — {decidedError}</Banner>}

        {isPending && (
          <div className="apv-actions">
            {rejecting ? (
              <form
                className="apv-reject"
                onSubmit={(e) => {
                  e.preventDefault();
                  onReject(reason.trim() || 'No reason given');
                }}
              >
                <input
                  type="text"
                  className="ui-control apv-reject__input"
                  autoFocus
                  placeholder="Why? (optional, shown to the requester)"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={500}
                />
                <Button variant="ghost" onClick={() => setRejecting(false)} disabled={busy}>
                  Cancel
                </Button>
                <Button type="submit" variant="danger" loading={busy}>
                  Confirm reject
                </Button>
              </form>
            ) : (
              <>
                <Button
                  variant="ghost"
                  icon={<X size={14} strokeWidth={2} />}
                  onClick={() => setRejecting(true)}
                  disabled={busy}
                >
                  Reject
                </Button>
                <Button
                  variant="primary"
                  icon={<Check size={14} strokeWidth={2.2} />}
                  onClick={onApprove}
                  loading={busy}
                >
                  Approve
                </Button>
              </>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

function TriageNote({ triage }: { triage: NonNullable<ManualTimeRequest['triage']> }) {
  const status = TRIAGE_STATUS[triage.verdict];
  const verdictLabel =
    triage.verdict === 'approve' ? 'Likely safe' : triage.verdict === 'reject' ? 'Worth pushing back' : 'Take a look';
  const confidencePct = Math.round(triage.confidence * 100);
  return (
    <div className="apv-triage" role="note" aria-label="AI triage suggestion">
      <div className="apv-triage__head">
        <span className="apv-triage__icon ui-t-eyebrow">
          <Sparkles size={12} strokeWidth={2.2} />
          AI read
        </span>
        <Tag status={status}>{verdictLabel}</Tag>
        <span className="apv-triage__conf mono" title={`${confidencePct}% confidence`}>
          {confidencePct}% sure
        </span>
      </div>
      <ul className="apv-triage__signals" role="list">
        {triage.signals.slice(0, 3).map((s) => (
          <li key={s.id} className="apv-triage__sig">
            <span className={`apv-triage__sigmark mono ${s.weight >= 0 ? 'apv-pos' : 'apv-neg'}`} aria-hidden>
              {s.weight >= 0 ? '+' : '−'}
            </span>
            {s.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Suppress unused-type warning for an enum we re-export indirectly.
export type { MtrStatus };
