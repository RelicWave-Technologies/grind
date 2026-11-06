import './tickets.css';
import { useMemo, useRef, useState } from 'react';
import { useNavigate, useRouteContext } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarDays,
  Clock4,
  HelpCircle,
  ImagePlus,
  KeyRound,
  LifeBuoy,
  Monitor,
  Plus,
  Send,
  X,
} from 'lucide-react';
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
import type { WorkspaceUser } from '../lib/types';
import { attachmentUrl, useTicketUploads, type TicketUploads } from '../components/TicketAttachments';
import {
  Banner,
  Button,
  Card,
  Combobox,
  EmptyState,
  Field,
  FilterBar,
  IconButton,
  Input,
  Modal,
  NoMatches,
  Page,
  PageHeader,
  Segmented,
  Select,
  SkeletonTable,
  Tabs,
  Tag,
  Textarea,
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

export const CATEGORY_ICON: Record<TicketCategory, typeof Monitor> = {
  TIMO_APP: Monitor,
  TIME_ATTENDANCE: Clock4,
  LEAVE_PAYROLL: CalendarDays,
  ACCESS: KeyRound,
  OTHER: HelpCircle,
};

const CATEGORY_HINT: Record<TicketCategory, string> = {
  TIMO_APP: 'Crashes, stops, will not update or sync',
  TIME_ATTENDANCE: 'Hours, late marks, punches, manual time',
  LEAVE_PAYROLL: 'Leave balance, WFH, salary days',
  ACCESS: 'Sign in, approval, permissions',
  OTHER: 'Anything else',
};

export function formatTicketTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone: tz, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

/** "just now", "12m ago", "3h ago", "2d ago", then the date. */
export function timeAgo(iso: string, tz: string, now = Date.now()): string {
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return new Intl.DateTimeFormat('en-IN', { timeZone: tz, day: 'numeric', month: 'short' }).format(new Date(iso));
}

type View = 'open' | 'resolved' | 'closed' | 'all';

function viewOf(t: TicketSummaryDto): Exclude<View, 'all'> {
  if (t.status === 'CLOSED') return 'closed';
  if (t.status === 'RESOLVED') return 'resolved';
  return 'open';
}

/** Support: your own tickets, and for admins the workspace queue. */
export function TicketsScreen() {
  const { me } = useRouteContext({ from: '/authed' });
  const navigate = useNavigate();
  const canManage = hasCapability(me, 'tickets.manage');
  const [scope, setScope] = useState<'mine' | 'all'>(() =>
    canManage && new URLSearchParams(window.location.search).get('scope') !== 'mine' ? 'all' : 'mine',
  );
  const [view, setView] = useState<View>('open');
  const [creating, setCreating] = useState(false);
  const q = useQuery({ ...ticketListQuery<TicketListResponse>(scope), refetchInterval: 60_000 });
  const tickets = q.data?.tickets ?? [];
  const tz = me.workspaceTimezone;
  const queue = scope === 'all';

  const filter = useTableFilter(tickets, {
    text: (t) => [`#${t.number}`, t.subject, t.requester.name, t.requester.email, t.assignee?.name, t.lastReply?.snippet],
    facets: {
      category: { label: 'Categories', value: (t) => t.category, optionLabel: (c) => TICKET_CATEGORY_LABEL[c as TicketCategory] ?? c },
      assignee: { label: 'Assignees', value: (t: TicketSummaryDto) => t.assignee?.name ?? 'Unassigned' },
    },
  });

  const tally = useMemo(() => {
    const c: Record<View, number> = { open: 0, resolved: 0, closed: 0, all: tickets.length };
    for (const t of tickets) c[viewOf(t)] += 1;
    return c;
  }, [tickets]);

  // Whoever owes the next move first, then most recently touched.
  const rows = useMemo(() => {
    const shown = view === 'all' ? filter.rows : filter.rows.filter((t) => viewOf(t) === view);
    const owes = (t: TicketSummaryDto) => (queue ? t.turn === 'ADMIN' : t.turn === 'REQUESTER') ? 0 : 1;
    return [...shown].sort((x, y) => owes(x) - owes(y) || y.updatedAt.localeCompare(x.updatedAt));
  }, [filter.rows, view, queue]);

  return (
    <Page className="tk-page">
      <PageHeader
        eyebrow="Support"
        title="Tickets"
        subtitle={
          canManage
            ? 'Problems and questions from the team. Each one also reaches you on Lark, pinned until it is solved.'
            : 'Tell us what is wrong and an admin replies here and on Lark.'
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
            { value: 'all', label: 'Team queue' },
            { value: 'mine', label: 'Opened by me' },
          ]}
        />
      )}

      {q.isError && <Banner status="danger">Couldn’t load tickets: {(q.error as Error).message}</Banner>}

      {q.isLoading ? (
        <Card variant="flush"><SkeletonTable rows={6} /></Card>
      ) : tickets.length === 0 ? (
        <HowItWorks onCreate={() => setCreating(true)} queue={queue} />
      ) : (
        <Card variant="flush">
          <div className="tk-listhead">
            <Tabs
              aria-label="Status"
              value={view}
              onChange={setView}
              items={(['open', 'resolved', 'closed', 'all'] as const).map((v) => ({
                value: v,
                label: `${v === 'open' ? 'Open' : v === 'resolved' ? 'Resolved' : v === 'closed' ? 'Closed' : 'All'} ${tally[v]}`,
              }))}
            />
          </div>
          <FilterBar filter={filter} placeholder="Search tickets" noun={{ one: 'ticket', other: 'tickets' }} />
          {rows.length === 0 ? (
            <NoMatches onClear={() => { filter.clear(); setView('all'); }} />
          ) : (
            <ul className="tk-list" aria-label="Tickets">
              {rows.map((t) => (
                <TicketRow
                  key={t.id}
                  t={t}
                  tz={tz}
                  queue={queue}
                  onOpen={() => void navigate({ to: '/tickets/$ticketId', params: { ticketId: t.id } })}
                />
              ))}
            </ul>
          )}
        </Card>
      )}

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

function TicketRow({ t, tz, queue, onOpen }: { t: TicketSummaryDto; tz: string; queue: boolean; onOpen: () => void }) {
  const yourMove = queue ? t.turn === 'ADMIN' : t.turn === 'REQUESTER';
  return (
    <li>
      <button type="button" className={yourMove ? 'tk-row tk-row--due' : 'tk-row'} onClick={onOpen}>
        <span className="tk-row__main">
          <span className="tk-row__subject"><span className="tk-row__num">#{t.number}</span> {t.subject}</span>
          <span className="tk-row__meta ui-t-small">
            {[queue ? t.requester.name : null, TICKET_CATEGORY_LABEL[t.category], t.assignee && queue ? `with ${t.assignee.name.split(' ')[0]}` : null]
              .filter(Boolean).join(' · ')}
          </span>
        </span>
        <span className="tk-row__side">
          <Tag status={TICKET_STATUS_TONE[t.status]} dot>{TICKET_STATUS_LABEL[t.status]}</Tag>
          <span className="tk-row__time ui-t-small" title={formatTicketTime(t.updatedAt, tz)}>{timeAgo(t.updatedAt, tz)}</span>
        </span>
      </button>
    </li>
  );
}

function HowItWorks({ onCreate, queue }: { onCreate: () => void; queue: boolean }) {
  return (
    <Card variant="flush">
      <EmptyState
        icon={<LifeBuoy size={22} strokeWidth={1.8} />}
        title={queue ? 'No tickets yet' : 'No tickets'}
        description={queue ? 'New tickets show up here and on Lark.' : 'Open one when something is wrong. You can also message the Timo bot on Lark starting with “ticket”.'}
        action={<Button variant="secondary" onClick={onCreate}>New ticket</Button>}
      />
    </Card>
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
  const [category, setCategory] = useState<TicketCategory | null>(null);
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
  const forName = people.find((p) => p.value === requesterId)?.label;

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string; number: number }>('/v1/tickets', {
        method: 'POST',
        json: {
          subject: subject.trim(),
          description: description.trim(),
          category: category ?? 'OTHER',
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

  const missing = [
    !category && 'a category',
    subject.trim().length < 3 && 'a subject',
    !description.trim() && 'what happened',
  ].filter(Boolean) as string[];
  const valid = missing.length === 0 && !uploads.busy;
  const errorCode = (create.error as { body?: { error?: string } } | null)?.body?.error;

  return (
    <Modal
      open
      onClose={onClose}
      title={forName ? `New ticket for ${forName}` : 'New ticket'}
      description={forName ? `${forName.split(' ')[0]} gets it on Lark and can reply there.` : 'An admin replies here and on Lark.'}
      actions={
        <>
          <span className="tk-modal-hint ui-t-small">{missing.length > 0 ? `Add ${missing.join(', ')}` : uploads.busy ? 'Uploading…' : 'Ready to send'}</span>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Send size={14} strokeWidth={1.8} />} disabled={!valid} loading={create.isPending} onClick={() => create.mutate()}>
            Open ticket
          </Button>
        </>
      }
    >
      <div className="tk-form">
        {canManage && (
          <div className="tk-form__row">
            <Field label="For">
              <Combobox aria-label="Who the ticket is for" value={requesterId} options={people} emptyLabel="Myself" onChange={setRequesterId} block />
            </Field>
            <Field label="Priority">
              <Select value={priority} onChange={(e) => setPriority(e.target.value as TicketPriority)}>
                {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{TICKET_PRIORITY_LABEL[p]}</option>)}
              </Select>
            </Field>
          </div>
        )}
        <Field label="Category">
          <div className="tk-cats" role="radiogroup" aria-label="Category">
            {TICKET_CATEGORIES.map((c) => {
              const Icon = CATEGORY_ICON[c];
              const on = category === c;
              return (
                <button key={c} type="button" role="radio" aria-checked={on} title={CATEGORY_HINT[c]} className={on ? 'tk-cat tk-cat--on' : 'tk-cat'} onClick={() => setCategory(c)}>
                  <Icon size={14} strokeWidth={1.8} aria-hidden />
                  {TICKET_CATEGORY_LABEL[c]}
                </button>
              );
            })}
          </div>
        </Field>
        <Field label="Subject" hint={`${subject.length}/120`}>
          <Input value={subject} maxLength={120} placeholder="One line, e.g. Tuesday’s hours are missing" onChange={(e) => setSubject(e.target.value)} />
        </Field>
        <Field label="What happened?">
          <Textarea
            rows={5}
            maxLength={5000}
            value={description}
            placeholder={'What were you doing? What did you expect, and what happened instead?\nDates and times help us find it fast.'}
            onChange={(e) => setDescription(e.target.value)}
            onPaste={uploads.onPaste}
          />
        </Field>
        <DropZone uploads={uploads} />
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

/** Drop, browse or paste screenshots; each shows as a preview once it is up. */
export function DropZone({ uploads, compact }: { uploads: TicketUploads; compact?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const pick = () => input.current?.click();
  return (
    <div className="tk-drop-wrap">
      <div
        className={['tk-drop', over && 'tk-drop--over', compact && 'tk-drop--compact'].filter(Boolean).join(' ')}
        role="button"
        tabIndex={0}
        aria-label="Add attachments"
        onClick={pick}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } }}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (e.dataTransfer.files.length) void uploads.add(e.dataTransfer.files);
        }}
      >
        <ImagePlus size={compact ? 15 : 18} strokeWidth={1.6} aria-hidden />
        <span className="ui-t-small">
          <strong>{uploads.busy ? 'Uploading…' : 'Add screenshots'}</strong>
          {compact ? null : <span className="tk-drop__sub"> · drop, click or paste · images, PDF or text up to 5 MB</span>}
        </span>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept="image/png,image/jpeg,image/webp,image/gif,application/pdf,text/plain"
          onChange={(e) => {
            if (e.target.files) void uploads.add(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {uploads.files.length > 0 && (
        <ul className="tk-previews">
          {uploads.files.map((f) => (
            <li key={f.id} className="tk-preview">
              {f.mimeType.startsWith('image/') ? <img src={attachmentUrl(f)} alt={f.fileName} /> : <span className="tk-preview__file ui-t-small">{f.fileName}</span>}
              <IconButton className="tk-preview__x" icon={<X size={12} strokeWidth={2.2} />} aria-label={`Remove ${f.fileName}`} onClick={() => uploads.remove(f.id)} />
            </li>
          ))}
        </ul>
      )}
      {uploads.error && <span className="ui-t-small tk-uploads__error">{uploads.error}</span>}
    </div>
  );
}
