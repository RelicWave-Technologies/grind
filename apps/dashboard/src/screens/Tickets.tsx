import './tickets.css';
import { useMemo, useState } from 'react';
import { useNavigate, useRouteContext } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LifeBuoy, Plus } from 'lucide-react';
import {
  TICKET_CATEGORIES,
  TICKET_CATEGORY_LABEL,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABEL,
  TICKET_STATUS_LABEL,
  type TicketCategory,
  type TicketListResponse,
  type TicketPriority,
  type TicketStatus,
  type TicketSummaryDto,
} from '@grind/types';
import { api } from '../lib/api';
import { hasCapability } from '../lib/auth';
import { ticketQueryKeys, ticketListQuery, workspaceUsersQuery } from '../lib/queries';
import { useTableFilter } from '../lib/tableFilter';
import { useTableSort } from '../lib/tableSort';
import type { WorkspaceUser } from '../lib/types';
import { TicketUploadPicker, useTicketUploads } from '../components/TicketAttachments';
import {
  Avatar,
  Banner,
  Button,
  Card,
  Combobox,
  EmptyState,
  Field,
  FilterBar,
  Identity,
  Input,
  Modal,
  NoMatches,
  Page,
  PageHeader,
  Segmented,
  Select,
  SkeletonTable,
  Table,
  Tag,
  Tbody,
  Td,
  Textarea,
  Th,
  THead,
  Tr,
  type Status,
} from '../ui';

export const TICKET_STATUS_TONE: Record<TicketStatus, Status> = {
  OPEN: 'danger',
  IN_PROGRESS: 'info',
  WAITING_ON_USER: 'warn',
  RESOLVED: 'success',
  CLOSED: 'neutral',
};

export const TICKET_PRIORITY_TONE: Record<TicketPriority, Status> = {
  LOW: 'neutral',
  NORMAL: 'neutral',
  HIGH: 'warn',
  URGENT: 'danger',
};

export function formatTicketTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone: tz, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

/** Support: your own tickets, and for admins the workspace queue. */
export function TicketsScreen() {
  const { me } = useRouteContext({ from: '/authed' });
  const navigate = useNavigate();
  const canManage = hasCapability(me, 'tickets.manage');
  const [scope, setScope] = useState<'mine' | 'all'>(() =>
    canManage && new URLSearchParams(window.location.search).get('scope') !== 'mine' ? 'all' : 'mine',
  );
  const [creating, setCreating] = useState(false);
  const q = useQuery(ticketListQuery<TicketListResponse>(scope));
  const tickets = q.data?.tickets ?? [];
  const tz = me.workspaceTimezone;

  const filter = useTableFilter(tickets, {
    text: (t) => [`#${t.number}`, t.subject, t.requester.name, t.requester.email, t.assignee?.name],
    facets: {
      status: { label: 'Statuses', value: (t) => t.status, optionLabel: (s) => TICKET_STATUS_LABEL[s as TicketStatus] ?? s },
      category: { label: 'Categories', value: (t) => t.category, optionLabel: (c) => TICKET_CATEGORY_LABEL[c as TicketCategory] ?? c },
      assignee: { label: 'Assignees', value: (t: TicketSummaryDto) => t.assignee?.name ?? 'Unassigned' },
    },
  });
  const sort = useTableSort(filter.rows, {
    number: (t) => t.number,
    subject: (t) => t.subject,
    requester: (t) => t.requester.name,
    status: (t) => t.status,
    priority: (t) => TICKET_PRIORITIES.indexOf(t.priority),
    updated: (t) => t.updatedAt,
  });
  const counts = q.data?.counts;
  const needAdmin = counts ? counts.OPEN + counts.IN_PROGRESS : 0;

  return (
    <Page className="tk-page">
      <PageHeader
        eyebrow="Support"
        title="Tickets"
        subtitle={
          canManage
            ? 'Problems and questions from the team. You also get each one on Lark.'
            : 'Something wrong with Timo, your time, leave or access? Open a ticket and an admin replies here and on Lark. You can also message the Timo bot on Lark.'
        }
        actions={
          <Button variant="primary" icon={<Plus size={14} strokeWidth={2} />} onClick={() => setCreating(true)}>
            New ticket
          </Button>
        }
      />

      {canManage && (
        <Segmented
          aria-label="Which tickets"
          value={scope}
          onChange={setScope}
          items={[
            { value: 'all', label: `All tickets${scope === 'all' && counts ? ` · ${needAdmin} open` : ''}` },
            { value: 'mine', label: 'Opened by me' },
          ]}
        />
      )}

      {q.isError && <Banner status="danger">Couldn’t load tickets: {(q.error as Error).message}</Banner>}

      <Card variant="flush">
        {q.isLoading ? (
          <SkeletonTable rows={6} />
        ) : tickets.length === 0 ? (
          <EmptyState
            icon={<LifeBuoy size={22} strokeWidth={1.8} />}
            title={scope === 'all' ? 'No tickets yet' : 'You have not opened any tickets'}
            description="Open one when something is wrong, and an admin will reply."
            action={<Button variant="secondary" onClick={() => setCreating(true)}>New ticket</Button>}
          />
        ) : (
          <>
            <FilterBar filter={filter} placeholder="Search #, subject, person…" noun={{ one: 'ticket', other: 'tickets' }} />
            {filter.rows.length === 0 ? (
              <NoMatches onClear={filter.clear} />
            ) : (
              <Table density="compact" className="tk-table">
                <THead>
                  <Tr>
                    <Th {...sort.th('number')} className="tk-col-num">#</Th>
                    <Th {...sort.th('subject')}>Subject</Th>
                    {scope === 'all' && <Th {...sort.th('requester')}>Requester</Th>}
                    <Th {...sort.th('status')}>Status</Th>
                    <Th {...sort.th('priority')}>Priority</Th>
                    {scope === 'all' && <Th>Assignee</Th>}
                    <Th {...sort.th('updated')} align="right">Updated</Th>
                  </Tr>
                </THead>
                <Tbody>
                  {sort.rows.map((t) => (
                    <Tr key={t.id} onClick={() => void navigate({ to: '/tickets/$ticketId', params: { ticketId: t.id } })}>
                      <Td className="tk-col-num ui-t-mono">#{t.number}</Td>
                      <Td>
                        <div className="tk-subject">
                          <span className="ui-t-strong">{t.subject}</span>
                          <span className="ui-t-small ui-ink-3">{TICKET_CATEGORY_LABEL[t.category]}{t.source === 'LARK' ? ' · from Lark' : t.source === 'ADMIN' ? ' · opened by an admin' : ''}</span>
                        </div>
                      </Td>
                      {scope === 'all' && (
                        <Td>
                          <Identity avatar={<Avatar name={t.requester.name} src={t.requester.avatarUrl ?? undefined} size={24} />} name={t.requester.name} />
                        </Td>
                      )}
                      <Td><Tag status={TICKET_STATUS_TONE[t.status]} dot>{TICKET_STATUS_LABEL[t.status]}</Tag></Td>
                      <Td>{t.priority === 'NORMAL' ? <span className="ui-ink-3">Normal</span> : <Tag status={TICKET_PRIORITY_TONE[t.priority]}>{TICKET_PRIORITY_LABEL[t.priority]}</Tag>}</Td>
                      {scope === 'all' && <Td>{t.assignee?.name ?? <span className="ui-ink-3">Unassigned</span>}</Td>}
                      <Td align="right" className="ui-t-small ui-ink-3">{formatTicketTime(t.updatedAt, tz)}</Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            )}
          </>
        )}
      </Card>

      {creating && (
        <NewTicketModal
          canManage={canManage}
          meId={me.id}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            void navigate({ to: '/tickets/$ticketId', params: { ticketId: id } });
          }}
        />
      )}
    </Page>
  );
}

function NewTicketModal({
  canManage,
  meId,
  onClose,
  onCreated,
}: {
  canManage: boolean;
  meId: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<TicketCategory>('OTHER');
  const [priority, setPriority] = useState<TicketPriority>('NORMAL');
  const [requesterId, setRequesterId] = useState('');
  // One key per open form: a double click or a retry files one ticket.
  const [idempotencyKey] = useState(() => `web-${crypto.randomUUID()}`);
  const uploads = useTicketUploads();
  const usersQ = useQuery({ ...workspaceUsersQuery<{ users: WorkspaceUser[] }>(), enabled: canManage });
  const people = useMemo(
    () => (usersQ.data?.users ?? []).filter((u) => u.id !== meId).map((u) => ({ value: u.id, label: u.name, keywords: [u.email] })),
    [usersQ.data, meId],
  );

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string; number: number }>('/v1/tickets', {
        method: 'POST',
        json: {
          subject,
          description,
          category,
          attachmentIds: uploads.ids,
          idempotencyKey,
          ...(canManage ? { priority, ...(requesterId ? { requesterId } : {}) } : {}),
        },
      }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ticketQueryKeys.all });
      onCreated(res.id);
    },
  });

  const valid = subject.trim().length >= 3 && description.trim().length > 0 && !uploads.busy;
  const errorCode = (create.error as { body?: { error?: string } } | null)?.body?.error;

  return (
    <Modal
      open
      onClose={onClose}
      title="New ticket"
      description={requesterId ? 'They get it on Lark and can reply there.' : 'An admin will reply here and on Lark.'}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} loading={create.isPending} onClick={() => create.mutate()}>
            Open ticket
          </Button>
        </>
      }
    >
      <div className="tk-form">
        {canManage && (
          <Field label="For">
            <Combobox
              aria-label="Who the ticket is for"
              value={requesterId}
              options={people}
              emptyLabel="Myself"
              onChange={setRequesterId}
              block
            />
          </Field>
        )}
        <Field label="Subject">
          <Input value={subject} maxLength={120} placeholder="Short summary, e.g. Tuesday's hours missing" onChange={(e) => setSubject(e.target.value)} autoFocus />
        </Field>
        <div className="tk-form__row">
          <Field label="Category">
            <Select value={category} onChange={(e) => setCategory(e.target.value as TicketCategory)}>
              {TICKET_CATEGORIES.map((c) => <option key={c} value={c}>{TICKET_CATEGORY_LABEL[c]}</option>)}
            </Select>
          </Field>
          {canManage && (
            <Field label="Priority">
              <Select value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)}>
                {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{TICKET_PRIORITY_LABEL[p]}</option>)}
              </Select>
            </Field>
          )}
        </div>
        <Field label="What happened?">
          <Textarea
            rows={6}
            maxLength={5000}
            value={description}
            placeholder="What were you doing, what did you expect, what happened instead? Dates and times help."
            onChange={(e) => setDescription(e.target.value)}
            onPaste={uploads.onPaste}
          />
        </Field>
        <TicketUploadPicker uploads={uploads} />
        {create.isError && (
          <Banner status="danger">
            {errorCode === 'rate_limited'
              ? 'You have opened a lot of tickets today. Reply on an open one instead.'
              : `Couldn’t open the ticket: ${(create.error as Error).message}`}
          </Banner>
        )}
      </div>
    </Modal>
  );
}
