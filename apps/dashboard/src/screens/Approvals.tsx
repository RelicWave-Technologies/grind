import './approvals.css';
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate, useRouteContext } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, Check, ChevronLeft, ChevronRight, Clock4, Inbox, X } from 'lucide-react';
import { api, type ApiError } from '../lib/api';
import { hasCapability, isManagerOrAbove } from '../lib/auth';
import type { DecideResult, ManualTimeRequest, MtrStatus, MtrUserSummary } from '../lib/types';
import { addDays, fmtAgeShort, fmtDayLabel, fmtDurationMs, fmtTime, todayKey } from '../lib/format';
import { reportQueryKeys } from '../lib/reportQueries';
import type { TaskOption } from '../components/TaskCombo';
import {
  Avatar,
  Banner,
  Button,
  Card,
  EmptyState,
  IconButton,
  Identity,
  Page,
  PageHeader,
  Segmented,
  SkeletonTable,
  Stat,
  StatRow,
  Table,
  Tabs,
  Tag,
  Tbody,
  Td,
  Th,
  THead,
  Toolbar,
  Tr,
} from '../ui';
import type { Rail, Status } from '../ui';

type ApprovalMode = 'you' | 'team';
type ApprovalFilter = 'ALL' | 'PENDING' | 'APPROVED' | 'REJECTED';

const MODE_TABS: ReadonlyArray<{ value: ApprovalMode; label: string }> = [
  { value: 'you', label: 'You' },
  { value: 'team', label: 'Team' },
];

const FILTER_TABS: ReadonlyArray<{ value: ApprovalFilter; label: string }> = [
  { value: 'ALL', label: 'All' },
  { value: 'PENDING', label: 'Pending' },
  { value: 'APPROVED', label: 'Accepted' },
  { value: 'REJECTED', label: 'Rejected' },
];

const STATUS_TAG: Record<MtrStatus, Status> = {
  PENDING: 'warn',
  APPROVED: 'success',
  REJECTED: 'danger',
  CANCELLED: 'neutral',
};

interface ApprovalListResponse<T> {
  from?: string;
  to?: string;
  tz?: string;
  scope?: 'self' | 'team' | 'workspace';
  requests: T[];
}

interface SelfApprovalRequest {
  id: string;
  status: MtrStatus;
  requestedStart: string;
  requestedEnd: string;
  reason: string;
  larkTaskGuid: string | null;
  taskSummary?: string | null;
  decidedAt: string | null;
  decidedReason: string | null;
  createdAt: string;
  approverId: string | null;
  approver?: MtrUserSummary | null;
}

type ApprovalRequest = SelfApprovalRequest | ManualTimeRequest;

interface ApprovalTableRow {
  source: ApprovalMode;
  req: ApprovalRequest;
  requester: MtrUserSummary | null;
}

type ApprovalTaskReadout = {
  kind: 'known' | 'missing' | 'none';
  label: string;
  reference: string | null;
};

export function ApprovalsScreen() {
  const { me } = useRouteContext({ from: '/authed' });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const tz = me.workspaceTimezone;
  const today = todayKey(tz);
  const canReview =
    hasCapability(me, 'approvals.team.decide') ||
    hasCapability(me, 'approvals.workspace.decide');
  const canSelfApproveOwn = isManagerOrAbove(me.role);
  const [mode, setMode] = useState<ApprovalMode>(() => (canReview ? 'team' : 'you'));
  const activeMode: ApprovalMode = canReview ? mode : 'you';
  const [from, setFrom] = useState(() => addDays(today, -6));
  const [to, setTo] = useState(today);
  const [filter, setFilter] = useState<ApprovalFilter>('ALL');
  const [selectedRow, setSelectedRow] = useState<ApprovalTableRow | null>(null);

  const selfQ = useQuery({
    queryKey: ['approvals', 'you', from, to, tz],
    enabled: activeMode === 'you',
    queryFn: () =>
      api<ApprovalListResponse<SelfApprovalRequest>>(
        `/v1/time-requests?${new URLSearchParams({ role: 'mine', from, to, tz }).toString()}`,
      ),
  });

  const teamQ = useQuery({
    queryKey: ['approvals', 'team', from, to, tz],
    enabled: canReview && activeMode === 'team',
    queryFn: () =>
      api<ApprovalListResponse<ManualTimeRequest>>(
        `/v1/admin/manual-time-requests?${new URLSearchParams({ status: 'ALL', from, to, tz }).toString()}`,
      ),
  });

  const tasksQ = useQuery({
    queryKey: ['lark', 'my-tasks', 'approval-labels'],
    enabled: activeMode === 'you',
    queryFn: async () => {
      try {
        return await api<{ tasks: TaskOption[] }>('/v1/lark/my-tasks');
      } catch {
        return { tasks: [] };
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });

  const taskMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of tasksQ.data?.tasks ?? []) map.set(task.guid, task.summary);
    return map;
  }, [tasksQ.data?.tasks]);

  const decide = useMutation({
    mutationFn: async (vars: { id: string; action: 'approve' | 'reject' }) => {
      return api<DecideResult>(`/v1/admin/manual-time-requests/${vars.id}/decide`, {
        method: 'POST',
        json: { action: vars.action },
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['approvals', 'team'] });
      queryClient.invalidateQueries({ queryKey: ['reports', 'team', 'member'] });
      queryClient.invalidateQueries({ queryKey: reportQueryKeys.teamSummaryRoot });
    },
  });

  const rows: ApprovalTableRow[] = useMemo(() => {
    if (activeMode === 'team') {
      return (teamQ.data?.requests ?? []).map((req) => ({ source: 'team', req, requester: req.user }));
    }
    return (selfQ.data?.requests ?? []).map((req) => ({ source: 'you', req, requester: null }));
  }, [activeMode, selfQ.data?.requests, teamQ.data?.requests]);

  const visible = useMemo(() => {
    const filtered = filter === 'ALL' ? rows : rows.filter((row) => row.req.status === filter);
    return [...filtered].sort((a, b) => {
      const priority = statusPriority(a.req.status) - statusPriority(b.req.status);
      if (priority !== 0) return priority;
      return new Date(b.req.requestedStart).getTime() - new Date(a.req.requestedStart).getTime();
    });
  }, [filter, rows]);

  const summary = useMemo(() => summarizeApprovals(rows.map((row) => row.req)), [rows]);
  const activeQuery = activeMode === 'team' ? teamQ : selfQ;
  const decisionError =
    decide.isError && decide.variables
      ? (decide.error as Error | ApiError).message
      : null;

  return (
    <Page className="apv-page">
      <PageHeader
        eyebrow={`${tz.replace(/_/g, ' ')} · ${from} to ${to}`}
        title="Approvals"
        subtitle={
          activeMode === 'team'
            ? 'Review manual time from your scoped team and keep Lark decisions in sync.'
            : 'Every manual-time approval you sent.'
        }
        actions={
          <Toolbar>
            {canReview && (
              <Segmented
                aria-label="Approval view"
                value={activeMode}
                onChange={(next) => {
                  setMode(next);
                  setFilter('ALL');
                  setSelectedRow(null);
                }}
                items={MODE_TABS}
              />
            )}
            <ApprovalDateRangePicker
              from={from}
              to={to}
              today={today}
              onChange={(nextFrom, nextTo) => {
                setFrom(nextFrom);
                setTo(nextTo);
                setSelectedRow(null);
              }}
            />
          </Toolbar>
        }
      />

      <Card variant="flush" className="apv-summary-card">
        <StatRow>
          <Stat label={activeMode === 'team' ? 'In scope' : 'Sent'} value={summary.total} hint={fmtDurationMs(summary.totalMs)} />
          <Stat label="Pending" value={summary.pending} hint={fmtDurationMs(summary.pendingMs)} />
          <Stat label="Accepted" value={summary.accepted} hint={fmtDurationMs(summary.acceptedMs)} />
          <Stat label="Rejected" value={summary.rejected} hint={fmtDurationMs(summary.rejectedMs)} />
        </StatRow>
      </Card>

      <Card variant="flush" className="apv-table-card">
        <div className="apv-table-head">
          <div>
            <h2 className="ui-t-title">{activeMode === 'team' ? 'Team approvals' : 'Your approvals'}</h2>
            <p className="ui-t-small">
              {activeMode === 'team'
                ? 'Approve or reject pending manual time directly from the row.'
                : 'Click a row to inspect the full request.'}
            </p>
          </div>
          <Tabs
            aria-label="Approval status"
            value={filter}
            onChange={setFilter}
            items={FILTER_TABS}
            className="apv-status-tabs"
          />
        </div>

        {activeQuery.isError && (
          <div className="apv-table-banner">
            <Banner status="danger">Couldn&apos;t load approvals — {(activeQuery.error as Error).message}</Banner>
          </div>
        )}

        {decisionError && (
          <div className="apv-table-banner">
            <Banner status="danger">Decision failed — {decisionError}</Banner>
          </div>
        )}

        {activeQuery.isLoading ? (
          <SkeletonTable rows={7} />
        ) : visible.length === 0 ? (
          <EmptyState
            icon={<Inbox size={22} strokeWidth={1.8} />}
            title={filter === 'ALL' ? 'No approvals in this range' : `No ${filterLabel(filter).toLowerCase()} approvals`}
            description="Try a wider date range or a different status."
          />
        ) : (
          <ApprovalTable
            mode={activeMode}
            rows={visible}
            tz={tz}
            taskMap={taskMap}
            currentUserId={me.id}
            canSelfApproveOwn={canSelfApproveOwn}
            busyRequestId={decide.isPending ? decide.variables?.id ?? null : null}
            busyAction={decide.isPending ? decide.variables?.action ?? null : null}
            onSelect={setSelectedRow}
            onOpenDay={(date, req, userId) => {
              navigate({ to: '/edit-time', search: editTimeSearch(date, req, userId) });
            }}
            onApprove={(id) => decide.mutate({ id, action: 'approve' })}
            onReject={(id) => decide.mutate({ id, action: 'reject' })}
          />
        )}
      </Card>

      {selectedRow && (
        <ApprovalDetailsModal
          row={selectedRow}
          tz={tz}
          task={approvalTaskReadout(selectedRow.req, taskMap)}
          onClose={() => setSelectedRow(null)}
          onOpenDay={(date, req, userId) => {
            setSelectedRow(null);
            navigate({ to: '/edit-time', search: editTimeSearch(date, req, userId) });
          }}
        />
      )}
    </Page>
  );
}

function ApprovalTable({
  mode,
  rows,
  tz,
  taskMap,
  currentUserId,
  canSelfApproveOwn,
  busyRequestId,
  busyAction,
  onSelect,
  onOpenDay,
  onApprove,
  onReject,
}: {
  mode: ApprovalMode;
  rows: ApprovalTableRow[];
  tz: string;
  taskMap: Map<string, string>;
  currentUserId: string;
  canSelfApproveOwn: boolean;
  busyRequestId: string | null;
  busyAction: 'approve' | 'reject' | null;
  onSelect: (row: ApprovalTableRow) => void;
  onOpenDay: (date: string, req: ApprovalRequest, userId?: string) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  return (
    <div className="apv-table-wrap">
      <Table density="compact" stickyHead className={`apv-table apv-table--${mode}`}>
        <THead>
          <Tr>
            {mode === 'team' && <Th className="apv-col-member">Member</Th>}
            <Th className="apv-col-date">Date</Th>
            <Th className="apv-col-time">Requested</Th>
            <Th className="apv-col-status" align="center">Status</Th>
            <Th className="apv-col-reason">Reason</Th>
            {mode === 'team' && <Th className="apv-col-actions" align="center">Action</Th>}
          </Tr>
        </THead>
        <Tbody>
          {rows.map((row) => {
            const req = row.req;
            const startMs = new Date(req.requestedStart).getTime();
            const endMs = new Date(req.requestedEnd).getTime();
            const date = dateKeyInTimeZone(startMs, tz);
            const createdMs = new Date(req.createdAt).getTime();
            const decidedMs = req.decidedAt ? new Date(req.decidedAt).getTime() : null;
            const task = approvalTaskReadout(req, taskMap);
            const userId = row.requester?.id;
            const isOwnRequest = userId === currentUserId;
            const isBusy = busyRequestId === req.id;
            return (
              <Tr
                key={`${row.source}-${req.id}`}
                rail={railForApprovalStatus(req.status)}
                className="apv-row"
                tabIndex={0}
                aria-label={`View approval details for ${date}`}
                onClick={() => onSelect(row)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(row);
                  }
                }}
              >
                {mode === 'team' && (
                  <Td className="apv-col-member">
                    {row.requester ? (
                      <Identity
                        name={row.requester.name}
                        subtitle={row.requester.email}
                        avatar={<Avatar name={row.requester.name} src={row.requester.avatarUrl ?? undefined} size={32} />}
                      />
                    ) : (
                      <span className="ui-t-small">Unknown member</span>
                    )}
                  </Td>
                )}
                <Td className="apv-col-date">
                  <div className="apv-date-cell">
                    <span className="ui-t-strong">{fmtDayLabel(date, tz)}</span>
                    <span className="ui-t-small ui-ink-3">{date}</span>
                  </div>
                </Td>
                <Td className="apv-col-time">
                  <div className="apv-time-cell">
                    <span className="ui-mono">{fmtTime(startMs, tz)} - {fmtTime(endMs, tz)}</span>
                    <Tag mono>{fmtDurationMs(endMs - startMs)}</Tag>
                  </div>
                </Td>
                <Td className="apv-col-status" align="center">
                  <ApprovalStatusCell req={req} createdMs={createdMs} decidedMs={decidedMs} timeZone={tz} />
                </Td>
                <Td className="apv-col-reason">
                  <div className="apv-reason-row">
                    <div className="apv-reason-cell">
                      <span className="apv-reason-main">{req.reason}</span>
                      {task.kind !== 'none' && (
                        <span className={`apv-reason-meta ui-t-small${task.kind === 'missing' ? ' is-missing' : ''}`}>
                          {task.label}
                        </span>
                      )}
                    </div>
                    {mode === 'you' && (
                      <IconButton
                        className="apv-open-day"
                        size="sm"
                        variant="ghost"
                        icon={<Clock4 size={13} strokeWidth={1.8} />}
                        aria-label={`Open Edit Time for ${date}`}
                        title="Open day"
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenDay(date, req);
                        }}
                      />
                    )}
                  </div>
                </Td>
                {mode === 'team' && (
                  <Td className="apv-col-actions" align="center">
                    <TeamDecisionCell
                      req={req}
                      isOwnRequest={isOwnRequest}
                      canSelfApproveOwn={canSelfApproveOwn}
                      busy={isBusy}
                      busyAction={isBusy ? busyAction : null}
                      onApprove={() => onApprove(req.id)}
                      onReject={() => onReject(req.id)}
                      onOpenDay={() => onOpenDay(date, req, userId)}
                    />
                  </Td>
                )}
              </Tr>
            );
          })}
        </Tbody>
      </Table>
    </div>
  );
}

function TeamDecisionCell({
  req,
  isOwnRequest,
  canSelfApproveOwn,
  busy,
  busyAction,
  onApprove,
  onReject,
  onOpenDay,
}: {
  req: ApprovalRequest;
  isOwnRequest: boolean;
  canSelfApproveOwn: boolean;
  busy: boolean;
  busyAction: 'approve' | 'reject' | null;
  onApprove: () => void;
  onReject: () => void;
  onOpenDay: () => void;
}) {
  if (req.status !== 'PENDING') {
    return (
      <div className="apv-team-decision apv-team-decision--done">
        <Tag status={STATUS_TAG[req.status]} mono>{approvalStatusLabel(req.status)}</Tag>
        <IconButton
          className="apv-team-open-day"
          size="sm"
          variant="ghost"
          icon={<Clock4 size={13} strokeWidth={1.8} />}
          aria-label="Open Edit Time"
          title="Open day"
          onClick={(e) => {
            e.stopPropagation();
            onOpenDay();
          }}
        />
      </div>
    );
  }
  if (isOwnRequest && !canSelfApproveOwn) {
    return (
      <div className="apv-team-decision apv-team-decision--done">
        <Tag status="neutral" mono>Needs reviewer</Tag>
        <IconButton
          className="apv-team-open-day"
          size="sm"
          variant="ghost"
          icon={<Clock4 size={13} strokeWidth={1.8} />}
          aria-label="Open Edit Time"
          title="Another approver must decide"
          onClick={(e) => {
            e.stopPropagation();
            onOpenDay();
          }}
        />
      </div>
    );
  }
  return (
    <div className="apv-team-decision">
      <Button
        size="sm"
        variant="danger"
        icon={<X size={13} strokeWidth={2} />}
        loading={busyAction === 'reject'}
        disabled={busy && busyAction !== 'reject'}
        onClick={(e) => {
          e.stopPropagation();
          onReject();
        }}
      >
        Reject
      </Button>
      <Button
        size="sm"
        variant="primary"
        icon={<Check size={13} strokeWidth={2.2} />}
        loading={busyAction === 'approve'}
        disabled={busy && busyAction !== 'approve'}
        onClick={(e) => {
          e.stopPropagation();
          onApprove();
        }}
      >
        Approve
      </Button>
    </div>
  );
}

function ApprovalStatusCell({
  req,
  createdMs,
  decidedMs,
  timeZone,
}: {
  req: ApprovalRequest;
  createdMs: number;
  decidedMs: number | null;
  timeZone: string;
}) {
  if (req.status === 'PENDING') {
    return (
      <div className="apv-status-cell">
        <Tag status="warn" mono>Pending</Tag>
        <span className="ui-t-small ui-ink-3" title={formatApprovalTimestamp(req.createdAt, timeZone)}>
          {fmtAgeShort(Date.now() - createdMs)}
        </span>
      </div>
    );
  }
  if (req.status === 'CANCELLED') {
    return (
      <div className="apv-status-cell">
        <Tag status="neutral" mono>Cancelled</Tag>
        <span className="ui-t-small ui-ink-3">Withdrawn</span>
      </div>
    );
  }
  return (
    <div className="apv-status-cell">
      <Tag status={STATUS_TAG[req.status]} mono>{approvalStatusLabel(req.status)}</Tag>
      <span className="ui-t-small ui-ink-3" title={req.decidedAt ? formatApprovalTimestamp(req.decidedAt, timeZone) : undefined}>
        {decidedMs ? `${fmtAgeShort(Date.now() - decidedMs)} decision` : '—'}
      </span>
    </div>
  );
}

function formatApprovalTimestamp(value: string, timeZone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
  }).format(new Date(value));
}

function ApprovalDetailsModal({
  row,
  tz,
  task,
  onClose,
  onOpenDay,
}: {
  row: ApprovalTableRow;
  tz: string;
  task: ApprovalTaskReadout;
  onClose: () => void;
  onOpenDay: (date: string, req: ApprovalRequest, userId?: string) => void;
}) {
  if (typeof document === 'undefined') return null;

  const req = row.req;
  const startMs = new Date(req.requestedStart).getTime();
  const endMs = new Date(req.requestedEnd).getTime();
  const date = dateKeyInTimeZone(startMs, tz);
  const decidedMs = req.decidedAt ? new Date(req.decidedAt).getTime() : null;
  const statusMeta =
    req.status === 'CANCELLED'
      ? 'Withdrawn'
      : decidedMs
        ? `${fmtAgeShort(Date.now() - decidedMs)} decision`
        : fmtAgeShort(Date.now() - new Date(req.createdAt).getTime());
  const userId = row.requester?.id;

  return createPortal(
    <div className="apv-detail-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="apv-detail-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Approval detail for ${date}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="apv-detail-head">
          <div>
            <span className="ui-t-eyebrow">{date}</span>
            <h2 className="ui-t-title">Approval · {fmtDayLabel(date, tz)}</h2>
          </div>
          <IconButton icon={<X size={16} strokeWidth={1.8} />} aria-label="Close" onClick={onClose} />
        </header>
        <div className="apv-detail-body">
          <div className="apv-detail-grid">
            {row.requester && (
              <DetailField label="Member">
                <span>{row.requester.name}</span>
                <span className="ui-t-small ui-ink-3">{row.requester.email}</span>
              </DetailField>
            )}
            <DetailField label="Status">
              <Tag status={STATUS_TAG[req.status]} mono>{approvalStatusLabel(req.status)}</Tag>
              <span className="ui-t-small ui-ink-3">{statusMeta}</span>
            </DetailField>
            <DetailField label="Requested">
              <span className="ui-mono">{fmtTime(startMs, tz)} - {fmtTime(endMs, tz)}</span>
              <Tag mono>{fmtDurationMs(endMs - startMs)}</Tag>
            </DetailField>
            <DetailField label="Task">
              <span className={task.kind === 'missing' ? 'apv-detail-missing' : undefined}>{task.label}</span>
              {task.kind === 'missing' && <span className="ui-t-small ui-ink-3">No current Lark task match</span>}
            </DetailField>
            <DetailField label="Reviewer">
              <span>{req.approver?.name ?? (row.source === 'team' ? 'Not decided yet' : 'Workspace approver')}</span>
              {req.approver?.email && <span className="ui-t-small ui-ink-3">{req.approver.email}</span>}
            </DetailField>
          </div>

          <section className="apv-detail-section">
            <span className="ui-t-eyebrow">Reason</span>
            <p>{req.reason}</p>
          </section>

          {req.decidedReason && (
            <section className="apv-detail-section">
              <span className="ui-t-eyebrow">Decision note</span>
              <p>{req.decidedReason}</p>
            </section>
          )}

          {task.reference && (
            <section className="apv-detail-ref">
              <span className="ui-t-eyebrow">Task reference</span>
              <code>{task.reference}</code>
            </section>
          )}

          <div className="apv-detail-foot">
            <Button
              size="sm"
              variant="secondary"
              icon={<Clock4 size={13} strokeWidth={1.8} />}
              onClick={() => onOpenDay(date, req, userId)}
            >
              Open Edit Time
            </Button>
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}

function DetailField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="apv-detail-field">
      <span className="ui-t-eyebrow">{label}</span>
      <div className="apv-detail-field-value">{children}</div>
    </div>
  );
}

function ApprovalDateRangePicker({
  from,
  to,
  today,
  onChange,
}: {
  from: string;
  to: string;
  today: string;
  onChange: (from: string, to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftFrom, setDraftFrom] = useState(from);
  const [draftTo, setDraftTo] = useState<string | null>(to);
  const [visibleMonth, setVisibleMonth] = useState(() => monthStart(parseDateKey(from)));
  const months: [Date, Date] = [visibleMonth, addMonths(visibleMonth, 1)];

  function openPicker() {
    setDraftFrom(from);
    setDraftTo(to);
    setVisibleMonth(monthStart(parseDateKey(from)));
    setOpen((v) => !v);
  }

  function chooseDay(day: string) {
    if (!draftFrom || draftTo) {
      setDraftFrom(day);
      setDraftTo(null);
      return;
    }
    if (Math.abs(daysBetween(draftFrom, day)) > 59) {
      setDraftFrom(day);
      setDraftTo(null);
      return;
    }
    const [nextFrom, nextTo] = day < draftFrom ? [day, draftFrom] : [draftFrom, day];
    setDraftFrom(nextFrom);
    setDraftTo(nextTo);
    onChange(nextFrom, nextTo);
    setOpen(false);
  }

  return (
    <div className="apv-date-range">
      <button
        type="button"
        className={`apv-date-trigger${open ? ' is-open' : ''}`}
        onClick={openPicker}
        aria-expanded={open}
        aria-haspopup="dialog"
      >
        <CalendarDays size={15} strokeWidth={1.8} />
        <span>{formatRangeLabel(from, to)}</span>
      </button>

      {open && (
        <div className="apv-date-popover" role="dialog" aria-label="Approval date range">
          <div className="apv-date-popover-head">
            <IconButton
              size="sm"
              icon={<ChevronLeft size={15} strokeWidth={1.8} />}
              aria-label="Previous month"
              onClick={() => setVisibleMonth(addMonths(visibleMonth, -1))}
            />
            <span className="ui-t-eyebrow">{formatMonthRange(months[0], months[1])}</span>
            <IconButton
              size="sm"
              icon={<ChevronRight size={15} strokeWidth={1.8} />}
              aria-label="Next month"
              onClick={() => setVisibleMonth(addMonths(visibleMonth, 1))}
            />
          </div>
          <div className="apv-calendars">
            {months.map((month) => (
              <ApprovalCalendarMonth
                key={dateKey(month)}
                month={month}
                today={today}
                draftFrom={draftFrom}
                draftTo={draftTo}
                onChoose={chooseDay}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ApprovalCalendarMonth({
  month,
  today,
  draftFrom,
  draftTo,
  onChoose,
}: {
  month: Date;
  today: string;
  draftFrom: string;
  draftTo: string | null;
  onChoose: (day: string) => void;
}) {
  const days = calendarCells(month);
  return (
    <section className="apv-calendar" aria-label={formatMonthLabel(month)}>
      <div className="apv-calendar-title">{formatMonthLabel(month)}</div>
      <div className="apv-calendar-weekdays" aria-hidden>
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, index) => (
          <span key={`${d}-${index}`}>{d}</span>
        ))}
      </div>
      <div className="apv-calendar-days">
        {days.map((day, index) => {
          if (!day) return <span key={`blank-${index}`} aria-hidden />;
          const disabled = day > today || (!draftTo && Math.abs(daysBetween(draftFrom, day)) > 59);
          const selectedStart = day === draftFrom;
          const selectedEnd = day === draftTo;
          const inRange = draftTo ? day >= draftFrom && day <= draftTo : day === draftFrom;
          return (
            <button
              key={day}
              type="button"
              className={[
                'apv-calendar-day',
                inRange ? ' is-in-range' : '',
                selectedStart ? ' is-start' : '',
                selectedEnd ? ' is-end' : '',
                day === today ? ' is-today' : '',
              ].join('')}
              disabled={disabled}
              onClick={() => onChoose(day)}
              aria-label={formatFullDateLabel(day)}
              aria-pressed={inRange}
            >
              {Number(day.slice(-2))}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function summarizeApprovals(requests: ApprovalRequest[]) {
  const out = {
    total: requests.length,
    pending: 0,
    accepted: 0,
    rejected: 0,
    totalMs: 0,
    pendingMs: 0,
    acceptedMs: 0,
    rejectedMs: 0,
  };
  for (const req of requests) {
    const dur = Math.max(0, new Date(req.requestedEnd).getTime() - new Date(req.requestedStart).getTime());
    out.totalMs += dur;
    if (req.status === 'PENDING') {
      out.pending += 1;
      out.pendingMs += dur;
    } else if (req.status === 'APPROVED') {
      out.accepted += 1;
      out.acceptedMs += dur;
    } else if (req.status === 'REJECTED') {
      out.rejected += 1;
      out.rejectedMs += dur;
    }
  }
  return out;
}

function approvalTaskReadout(req: ApprovalRequest, taskMap: Map<string, string>): ApprovalTaskReadout {
  const stored = cleanTaskLabel(req.taskSummary);
  if (stored) return { kind: 'known', label: stored, reference: req.larkTaskGuid };
  const guid = cleanTaskLabel(req.larkTaskGuid);
  if (!guid) return { kind: 'none', label: 'Untracked', reference: null };
  const live = cleanTaskLabel(taskMap.get(guid));
  if (live) return { kind: 'known', label: live, reference: guid };
  return { kind: 'missing', label: 'Task unavailable', reference: guid };
}

function editTimeSearch(date: string, req: ApprovalRequest, userId?: string) {
  const search: {
    date: string;
    userId?: string;
    requestId: string;
    focusStart: string;
    focusEnd: string;
  } = {
    date,
    requestId: req.id,
    focusStart: String(new Date(req.requestedStart).getTime()),
    focusEnd: String(new Date(req.requestedEnd).getTime()),
  };
  if (userId) search.userId = userId;
  return search;
}

function dateKeyInTimeZone(ms: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const day = parts.find((part) => part.type === 'day')?.value;
  return year && month && day ? `${year}-${month}-${day}` : new Date(ms).toISOString().slice(0, 10);
}

function cleanTaskLabel(value: string | null | undefined): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}

function statusPriority(status: MtrStatus): number {
  if (status === 'PENDING') return 0;
  if (status === 'REJECTED') return 1;
  if (status === 'APPROVED') return 2;
  return 3;
}

function approvalStatusLabel(status: MtrStatus): string {
  if (status === 'APPROVED') return 'Accepted';
  if (status === 'REJECTED') return 'Rejected';
  if (status === 'PENDING') return 'Pending';
  return 'Cancelled';
}

function filterLabel(filter: ApprovalFilter): string {
  if (filter === 'APPROVED') return 'Accepted';
  if (filter === 'REJECTED') return 'Rejected';
  if (filter === 'PENDING') return 'Pending';
  return 'All';
}

function railForApprovalStatus(status: MtrStatus): Rail | undefined {
  if (status === 'APPROVED') return 'success';
  if (status === 'PENDING') return 'warn';
  if (status === 'REJECTED') return 'danger';
  return undefined;
}

function parseDateKey(key: string): Date {
  const [year, month, day] = key.split('-').map((part) => Number.parseInt(part, 10));
  return new Date(year!, month! - 1, day!);
}

function dateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function monthStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, delta: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function daysBetween(a: string, b: string): number {
  return Math.round((parseDateKey(b).getTime() - parseDateKey(a).getTime()) / (24 * 60 * 60 * 1000));
}

function calendarCells(month: Date): Array<string | null> {
  const start = monthStart(month);
  const firstDay = (start.getDay() + 6) % 7;
  const count = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  const cells: Array<string | null> = Array.from({ length: firstDay }, () => null);
  for (let day = 1; day <= count; day += 1) {
    cells.push(dateKey(new Date(start.getFullYear(), start.getMonth(), day)));
  }
  return cells;
}

function formatRangeLabel(from: string, to: string): string {
  return `${formatShortDateLabel(from)} - ${formatShortDateLabel(to)}`;
}

function formatShortDateLabel(key: string): string {
  const d = parseDateKey(key);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(d);
}

function formatMonthLabel(date: Date): string {
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(date);
}

function formatMonthRange(a: Date, b: Date): string {
  return `${formatMonthLabel(a)} / ${formatMonthLabel(b)}`;
}

function formatFullDateLabel(key: string): string {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(parseDateKey(key));
}
