import './tickets.css';
import { useMemo, useRef, useState } from 'react';
import { useNavigate, useRouteContext } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CalendarDays,
  CircleCheck,
  CircleDashed,
  CircleDot,
  CirclePause,
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
import type { WorkspaceUser } from '../lib/types';
import { attachmentUrl, useTicketUploads, type TicketUploads } from '../components/TicketAttachments';
import {
  Avatar,
  Banner,
  Button,
  Card,
  Combobox,
  EmptyState,
  Field,
  IconButton,
  Input,
  Modal,
  Page,
  Select,
  SearchInput,
  SkeletonTable,
  matchesQuery,
  normalizeText,
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

/** The status glyph: the one place colour says where a ticket stands. */
export function StatusIcon({ status, size = 16 }: { status: TicketStatus; size?: number }) {
  const props = { size, strokeWidth: 2, 'aria-label': TICKET_STATUS_LABEL[status] } as const;
  switch (status) {
    case 'OPEN': return <CircleDot {...props} className="tk-si tk-si--open" />;
    case 'IN_PROGRESS': return <CircleDashed {...props} className="tk-si tk-si--progress" />;
    case 'WAITING_ON_USER': return <CirclePause {...props} className="tk-si tk-si--waiting" />;
    case 'RESOLVED': return <CircleCheck {...props} className="tk-si tk-si--resolved" />;
    default: return <CircleCheck {...props} className="tk-si tk-si--closed" />;
  }
}

type Group = { key: string; label: string; rows: TicketSummaryDto[] };

/** Sections that answer "what needs me": who owes the next move, then the rest. */
function groupTickets(rows: TicketSummaryDto[], view: View, queue: boolean): Group[] {
  const by = (pred: (t: TicketSummaryDto) => boolean) => rows.filter(pred);
  const recent = (list: TicketSummaryDto[]) => [...list].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt));
  const groups: Group[] = view === 'open' || view === 'all'
    ? queue
      ? [
          { key: 'reply', label: 'Needs a reply', rows: by((t) => viewOf(t) === 'open' && t.turn === 'ADMIN') },
          { key: 'progress', label: 'In progress', rows: by((t) => t.status === 'IN_PROGRESS' && t.turn !== 'ADMIN') },
          { key: 'waiting', label: 'Waiting on requester', rows: by((t) => t.status === 'WAITING_ON_USER') },
        ]
      : [
          { key: 'you', label: 'Waiting on you', rows: by((t) => t.status === 'WAITING_ON_USER') },
          { key: 'support', label: 'With support', rows: by((t) => t.status === 'OPEN' || t.status === 'IN_PROGRESS') },
        ]
    : [];
  if (view === 'resolved' || view === 'all') {
    groups.push({ key: 'resolved', label: queue ? 'Resolved, awaiting confirmation' : 'Check the fix', rows: by((t) => t.status === 'RESOLVED') });
  }
  if (view === 'closed' || view === 'all') groups.push({ key: 'closed', label: 'Closed', rows: by((t) => t.status === 'CLOSED') });
  return groups.map((g) => ({ ...g, rows: recent(g.rows) })).filter((g) => g.rows.length > 0);
}

/** Support: your own tickets, and for admins the team's queue. */
export function TicketsScreen() {
  const { me } = useRouteContext({ from: '/authed' });
  const navigate = useNavigate();
  const canManage = hasCapability(me, 'tickets.manage');
  const [scope, setScope] = useState<'mine' | 'all'>(() =>
    canManage && new URLSearchParams(window.location.search).get('scope') !== 'mine' ? 'all' : 'mine',
  );
  const [view, setView] = useState<View | null>(null);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const q = useQuery({ ...ticketListQuery<TicketListResponse>(scope), refetchInterval: 60_000 });
  const tickets = q.data?.tickets ?? [];
  const tz = me.workspaceTimezone;
  const queue = scope === 'all';

  const tally = useMemo(() => {
    const c: Record<View, number> = { open: 0, resolved: 0, closed: 0, all: tickets.length };
    for (const t of tickets) c[viewOf(t)] += 1;
    return c;
  }, [tickets]);
  // Open first; if nothing is open, whatever has something in it.
  const current: View = view ?? (tally.open > 0 ? 'open' : tally.resolved > 0 ? 'resolved' : 'all');

  const groups = useMemo(() => {
    const needle = normalizeText(query);
    const matched = needle
      ? tickets.filter((t) => matchesQuery([`#${t.number}`, t.subject, t.requester.name, t.assignee?.name, TICKET_CATEGORY_LABEL[t.category]], needle))
      : tickets;
    const inView = current === 'all' ? matched : matched.filter((t) => viewOf(t) === current);
    return groupTickets(inView, current, queue);
  }, [tickets, query, current, queue]);

  const tabs: Array<{ key: View; label: string }> = [
    { key: 'open', label: 'Open' },
    { key: 'resolved', label: 'Resolved' },
    { key: 'closed', label: 'Closed' },
    { key: 'all', label: 'All' },
  ];

  return (
    <Page className="tk-page">
      <div className="tk-top">
        <div>
          <span className="ui-t-eyebrow">Support</span>
          <h1 className="tk-top__title">{queue ? 'Tickets' : 'My tickets'}</h1>
        </div>
        <Button variant="primary" icon={<Plus size={14} strokeWidth={2} />} onClick={() => setCreating(true)}>
          New ticket
        </Button>
      </div>

      <div className="tk-bar">
        <div className="tk-seg" role="tablist" aria-label="Status">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              type="button"
              role="tab"
              aria-selected={current === tab.key}
              className={current === tab.key ? 'tk-seg__btn tk-seg__btn--on' : 'tk-seg__btn'}
              onClick={() => setView(tab.key)}
            >
              {tab.label}
              <span className="tk-seg__count">{tally[tab.key]}</span>
            </button>
          ))}
        </div>
        <div className="tk-bar__right">
          {canManage && (
            <Select className="ui-select--pill" aria-label="Whose tickets" value={scope} onChange={(e) => { setScope(e.target.value as 'mine' | 'all'); setView(null); }}>
              <option value="all">Team queue</option>
              <option value="mine">Opened by me</option>
            </Select>
          )}
          <SearchInput value={query} onChange={setQuery} placeholder="Search" aria-label="Search tickets" />
        </div>
      </div>

      {q.isError && <Banner status="danger">Couldn’t load tickets: {(q.error as Error).message}</Banner>}

      {q.isLoading ? (
        <Card variant="flush"><SkeletonTable rows={6} /></Card>
      ) : tickets.length === 0 ? (
        <HowItWorks onCreate={() => setCreating(true)} queue={queue} />
      ) : groups.length === 0 ? (
        <div className="tk-none">
          <span className="ui-t-strong">{query ? `Nothing matches “${query}”` : 'Nothing here'}</span>
          {query && <button type="button" className="tk-linkish ui-t-small" onClick={() => setQuery('')}>Clear search</button>}
        </div>
      ) : (
        <div className="tk-panel">
          {groups.map((g) => (
            <section key={g.key} className="tk-group" aria-label={g.label}>
              <h2 className="tk-group__head">
                <span>{g.label}</span>
                <span className="tk-group__count">{g.rows.length}</span>
              </h2>
              <ul className="tk-list">
                {g.rows.map((t) => (
                  <TicketRow
                    key={t.id}
                    t={t}
                    tz={tz}
                    queue={queue}
                    onOpen={() => void navigate({ to: '/tickets/$ticketId', params: { ticketId: t.id } })}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
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
  const urgent = t.priority === 'HIGH' || t.priority === 'URGENT';
  return (
    <li>
      <button type="button" className={queue ? 'tk-row tk-row--queue' : 'tk-row'} onClick={onOpen}>
        <StatusIcon status={t.status} />
        <span className="tk-row__main">
          <span className="tk-row__line">
            <span className="tk-row__num">{t.number}</span>
            <span className="tk-row__subject">{t.subject}</span>
            {urgent && <span className={`tk-row__prio tk-row__prio--${t.priority.toLowerCase()}`}>{TICKET_PRIORITY_LABEL[t.priority]}</span>}
          </span>
          <span className="tk-row__sub">
            {TICKET_STATUS_LABEL[t.status]} · {TICKET_CATEGORY_LABEL[t.category]}
            {t.source === 'LARK' ? ' · from Lark' : ''}
          </span>
        </span>
        {queue && (
          <span className="tk-row__who">
            <Avatar name={t.requester.name} src={t.requester.avatarUrl ?? undefined} size={24} />
            <span>{t.requester.name}</span>
          </span>
        )}
        <span className="tk-row__assignee" title={t.assignee ? `With ${t.assignee.name}` : 'Unassigned'}>
          {t.assignee ? <Avatar name={t.assignee.name} src={t.assignee.avatarUrl ?? undefined} size={24} /> : <span className="tk-row__nobody" />}
        </span>
        <span className="tk-row__time" title={formatTicketTime(t.updatedAt, tz)}>{timeAgo(t.updatedAt, tz)}</span>
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
