import { Fragment, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import {
  RESYNC_MAX_DAYS,
  daysBetween,
  todayKey,
  type AgentCommandDto,
  type AgentCommandStatus,
  type AgentCommandTargetDto,
} from '@grind/types';
import { api } from '../lib/api';
import { useMe } from '../lib/auth';
import {
  Page,
  PageHeader,
  Card,
  Field,
  Input,
  Select,
  Button,
  IconButton,
  Banner,
  EmptyState,
  Table,
  THead,
  Tbody,
  Tr,
  Th,
  Td,
  Tag,
  SkeletonTable,
  type Status,
} from '../ui';
import './devresync.css';

/**
 * Hidden developer tool: ask one person's Timo to re-send its local time,
 * activity and screenshots for a date range. Reached only by URL
 * (/dev/resync) and only for DEVELOPER_EMAILS; the person is not notified.
 */

const STATUS_TONE: Record<AgentCommandStatus, Status> = {
  PENDING: 'neutral',
  DELIVERED: 'info',
  DONE: 'success',
  FAILED: 'danger',
  EXPIRED: 'warn',
};

const STATUS_LABEL: Record<AgentCommandStatus, string> = {
  PENDING: 'Waiting for agent',
  DELIVERED: 'Running',
  DONE: 'Done',
  FAILED: 'Failed',
  EXPIRED: 'Expired',
};

function stamp(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function rangeLabel(params: Record<string, unknown>): string {
  const from = typeof params.from === 'string' ? params.from : '?';
  const to = typeof params.to === 'string' ? params.to : '?';
  return from === to ? from : `${from} → ${to}`;
}

function lastSeen(person: AgentCommandTargetDto): string {
  if (!person.agentVersion) return 'no agent yet';
  return `${person.agentVersion} · seen ${stamp(person.agentLastSeenAt)}`;
}

export function DevResyncScreen() {
  const qc = useQueryClient();
  const me = useMe().data;
  const today = useMemo(() => todayKey(me?.workspaceTimezone ?? 'UTC'), [me?.workspaceTimezone]);
  const [userId, setUserId] = useState('');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    setFrom(today);
    setTo(today);
  }, [today]);

  const peopleQ = useQuery({
    queryKey: ['dev', 'people'],
    queryFn: () => api<{ people: AgentCommandTargetDto[] }>('/v1/dev/people'),
  });

  const commandsQ = useQuery({
    queryKey: ['dev', 'agent-commands'],
    queryFn: () => api<{ commands: AgentCommandDto[] }>('/v1/dev/agent-commands'),
    // Poll only while some agent still owes an answer.
    refetchInterval: (query) =>
      query.state.data?.commands.some((c) => c.status === 'PENDING' || c.status === 'DELIVERED') ? 5_000 : false,
  });

  const send = useMutation({
    mutationFn: () =>
      api<AgentCommandDto>('/v1/dev/agent-commands', {
        method: 'POST',
        json: { userId, type: 'RESYNC', from, to },
      }),
    onSuccess: (created) => {
      setOpen(created.id);
      void qc.invalidateQueries({ queryKey: ['dev', 'agent-commands'] });
    },
  });

  const rangeError = !from || !to
    ? 'Pick both dates.'
    : from > to
      ? '“From” is after “To”.'
      : daysBetween(from, to) + 1 > RESYNC_MAX_DAYS
        ? `At most ${RESYNC_MAX_DAYS} days at a time.`
        : null;
  const selected = peopleQ.data?.people.find((p) => p.id === userId) ?? null;
  const canSend = Boolean(userId) && rangeError === null && !send.isPending;

  return (
    <Page>
      <PageHeader
        eyebrow="Developer"
        title="Re-send agent data"
        subtitle="Ask a person’s Timo to upload its local time, activity and screenshots again. It runs on the agent’s next heartbeat, silently."
      />

      <Card className="dev-form-card rise rise-1">
        <div className="dev-form">
          <Field label="Person" hint={selected ? lastSeen(selected) : 'Everyone active in the workspace.'}>
            <Select value={userId} onChange={(e) => setUserId(e.target.value)} disabled={peopleQ.isLoading}>
              <option value="">{peopleQ.isLoading ? 'Loading…' : 'Choose a person'}</option>
              {peopleQ.data?.people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.email}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="From" error={rangeError ?? undefined}>
            <Input className="dev-date" type="date" value={from} max={today} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="To">
            <Input className="dev-date" type="date" value={to} max={today} onChange={(e) => setTo(e.target.value)} />
          </Field>
          <Button
            variant="primary"
            icon={<RefreshCw size={16} strokeWidth={2} />}
            loading={send.isPending}
            disabled={!canSend}
            onClick={() => send.mutate()}
          >
            Re-send
          </Button>
        </div>
        {send.isError && (
          <div className="dev-inline-banner">
            <Banner status="danger">{(send.error as Error).message}</Banner>
          </div>
        )}
        {peopleQ.isError && (
          <div className="dev-inline-banner">
            <Banner status="danger">Couldn’t load people. {(peopleQ.error as Error).message}</Banner>
          </div>
        )}
      </Card>

      <Card variant="flush" className="dev-table-card rise rise-2" title="Recent requests">
        {commandsQ.isLoading ? (
          <SkeletonTable rows={4} />
        ) : commandsQ.isError ? (
          <EmptyState tone="danger" title="Couldn’t load requests" description={(commandsQ.error as Error).message} />
        ) : commandsQ.data?.commands.length ? (
          <div className="dev-table-wrap">
            <Table density="compact">
              <THead>
                <Tr>
                  <Th aria-label="Details" />
                  <Th>Person</Th>
                  <Th>Range</Th>
                  <Th>Status</Th>
                  <Th>Requested</Th>
                  <Th>Completed</Th>
                </Tr>
              </THead>
              <Tbody>
                {commandsQ.data.commands.map((c) => {
                  const expanded = open === c.id;
                  const timedOut = c.result?.timedOut === true;
                  return (
                    <Fragment key={c.id}>
                      <Tr onClick={() => setOpen(expanded ? null : c.id)} selected={expanded}>
                        <Td className="dev-toggle-cell">
                          <IconButton
                            aria-label={expanded ? 'Hide result' : 'Show result'}
                            variant="ghost"
                            size="sm"
                            icon={expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            onClick={(e) => {
                              e.stopPropagation();
                              setOpen(expanded ? null : c.id);
                            }}
                          />
                        </Td>
                        <Td>
                          <div className="dev-person">
                            <span className="ui-t-strong">{c.user.name}</span>
                            <span className="ui-t-small">{c.user.email}</span>
                          </div>
                        </Td>
                        <Td className="dev-mono">{rangeLabel(c.params)}</Td>
                        <Td>
                          <div className="dev-tags">
                            <Tag status={STATUS_TONE[c.status]} dot>{STATUS_LABEL[c.status]}</Tag>
                            {timedOut && <Tag status="warn">Still uploading</Tag>}
                          </div>
                        </Td>
                        <Td className="dev-mono">{stamp(c.createdAt)}</Td>
                        <Td className="dev-mono">{stamp(c.completedAt)}</Td>
                      </Tr>
                      {expanded && (
                        <Tr className="dev-detail-row">
                          <Td colSpan={6}>
                            <ResultSummary command={c} />
                          </Td>
                        </Tr>
                      )}
                    </Fragment>
                  );
                })}
              </Tbody>
            </Table>
          </div>
        ) : (
          <EmptyState title="No requests yet" description="Pick a person and a date range above." />
        )}
      </Card>
    </Page>
  );
}

function ResultSummary({ command }: { command: AgentCommandDto }) {
  if (command.status === 'PENDING') {
    return <p className="ui-t-small dev-detail-note">Waiting for the agent’s next heartbeat (up to a minute if it is online).</p>;
  }
  if (command.status === 'DELIVERED') {
    return <p className="ui-t-small dev-detail-note">The agent has it and is re-sending; it reports back within about two minutes.</p>;
  }
  const body = command.error && !command.result ? { error: command.error } : { ...(command.error ? { error: command.error } : {}), ...command.result };
  const facts = summarize(command.result);
  return (
    <div className="dev-detail">
      <span className="ui-t-eyebrow">Requested by {command.requestedBy.name}</span>
      {facts.length > 0 && (
        <dl className="dev-facts">
          {facts.map(([label, value]) => (
            <div key={label} className="dev-fact">
              <dt className="ui-t-eyebrow">{label}</dt>
              <dd className="dev-mono">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      <pre className="dev-json">{JSON.stringify(body, null, 2)}</pre>
    </div>
  );
}

function num(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('en-IN') : '—';
}

function part(result: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = result[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The few numbers worth reading at a glance; the raw result sits below. */
function summarize(result: Record<string, unknown> | null): Array<[string, string]> {
  if (!result || !('timer' in result)) return [];
  const timer = part(result, 'timer');
  const activity = part(result, 'activity');
  const shots = part(result, 'screenshots');
  const errors = Array.isArray(timer.lastErrors) ? timer.lastErrors.filter((e) => typeof e === 'string') : [];
  const seconds = typeof result.durationMs === 'number' ? `${(result.durationMs / 1000).toFixed(1)} s` : '—';
  return [
    ['Time entries', `${num(timer.requeued)} re-sent · ${num(timer.pendingAfter)} still queued${timer.openRequeued ? ' · running one too' : ''}${timer.skippedRecovered ? ` · ${num(timer.skippedRecovered)} crash-recovered kept as is` : ''}`],
    ['Activity minutes', `${num(activity.requeued)} re-sent · ${num(activity.pendingAfter)} still queued`],
    ['Screenshots', `${num(shots.requeued)} re-queued · ${num(shots.uploaded)} uploaded · ${num(shots.failed)} failed · ${num(shots.pendingAfter)} waiting`],
    ['Agent', `${String(result.appVersion ?? '—')} · ${String(result.os ?? '—')} ${String(result.arch ?? '')} · ${seconds}`],
    ...(errors.length > 0 ? [['Sync errors', errors.join(', ')] as [string, string]] : []),
  ];
}
