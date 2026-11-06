import './tickets.css';
import { useMemo, useRef, useState } from 'react';
import { useNavigate, useRouteContext } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight,
  CalendarDays,
  Clock4,
  HelpCircle,
  ImagePlus,
  KeyRound,
  LifeBuoy,
  MessageSquareText,
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
  Avatar,
  Banner,
  Button,
  Card,
  Combobox,
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
  Stat,
  StatRow,
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

type View = 'attention' | 'progress' | 'waiting' | 'resolved' | 'closed' | 'all';

/** Which band tile a ticket counts under. */
function viewOf(t: TicketSummaryDto): Exclude<View, 'all'> {
  if (t.status === 'CLOSED') return 'closed';
  if (t.status === 'RESOLVED') return 'resolved';
  if (t.status === 'WAITING_ON_USER') return 'waiting';
  return t.turn === 'ADMIN' ? 'attention' : 'progress';
}

/** Support: your own tickets, and for admins the workspace queue. */
export function TicketsScreen() {
  const { me } = useRouteContext({ from: '/authed' });
  const navigate = useNavigate();
  const canManage = hasCapability(me, 'tickets.manage');
  const [scope, setScope] = useState<'mine' | 'all'>(() =>
    canManage && new URLSearchParams(window.location.search).get('scope') !== 'mine' ? 'all' : 'mine',
  );
  const [view, setView] = useState<View>('all');
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
    const c: Record<Exclude<View, 'all'>, number> = { attention: 0, progress: 0, waiting: 0, resolved: 0, closed: 0 };
    for (const t of tickets) c[viewOf(t)] += 1;
    return c;
  }, [tickets]);

  // Whoever owes the next move first, then priority, then most recently touched.
  const rows = useMemo(() => {
    const shown = view === 'all' ? filter.rows : filter.rows.filter((t) => viewOf(t) === view);
    const rank = (t: TicketSummaryDto) => {
      const v = viewOf(t);
      if (queue) return ['attention', 'progress', 'waiting', 'resolved', 'closed'].indexOf(v);
      return t.turn === 'REQUESTER' ? 0 : v === 'closed' ? 2 : 1;
    };
    return [...shown].sort((a, b) =>
      rank(a) - rank(b)
      || TICKET_PRIORITIES.indexOf(b.priority) - TICKET_PRIORITIES.indexOf(a.priority)
      || b.updatedAt.localeCompare(a.updatedAt));
  }, [filter.rows, view, queue]);

  const tiles: Array<{ key: Exclude<View, 'all'>; label: string; hint: string }> = queue
    ? [
        { key: 'attention', label: 'Needs a reply', hint: 'waiting on an admin' },
        { key: 'progress', label: 'In progress', hint: 'being worked on' },
        { key: 'waiting', label: 'With requester', hint: 'asked for more info' },
        { key: 'resolved', label: 'Resolved', hint: 'awaiting confirmation' },
        { key: 'closed', label: 'Closed', hint: 'done' },
      ]
    : [
        { key: 'waiting', label: 'Your reply needed', hint: 'an admin asked you' },
        { key: 'resolved', label: 'Check the fix', hint: 'confirm it works' },
        { key: 'attention', label: 'With support', hint: 'waiting for an admin' },
        { key: 'progress', label: 'In progress', hint: 'being worked on' },
        { key: 'closed', label: 'Closed', hint: 'done' },
      ];
  const toggle = (key: Exclude<View, 'all'>) => setView((cur) => (cur === key ? 'all' : key));

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
          onChange={(v) => { setScope(v); setView('all'); }}
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
        <>
          <Card variant="flush" className="tk-band">
            <StatRow>
              {tiles.map((tile) => (
                <Stat
                  key={tile.key}
                  label={tile.label}
                  value={tally[tile.key]}
                  hint={tile.hint}
                  role="button"
                  tabIndex={0}
                  aria-pressed={view === tile.key}
                  className={view === tile.key ? 'tk-tile tk-tile--on' : 'tk-tile'}
                  onClick={() => toggle(tile.key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggle(tile.key);
                    }
                  }}
                />
              ))}
            </StatRow>
          </Card>

          <Card variant="flush">
            <FilterBar filter={filter} placeholder="Search #, subject, person, reply…" noun={{ one: 'ticket', other: 'tickets' }} />
            {view !== 'all' && (
              <div className="tk-viewing ui-t-small">
                Showing <strong>{tiles.find((t) => t.key === view)?.label}</strong>
                <button type="button" className="tk-linkish" onClick={() => setView('all')}>Show all</button>
              </div>
            )}
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
        </>
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

/** The nudge on a row: whose move it is, said plainly. */
function TurnBadge({ t, queue }: { t: TicketSummaryDto; queue: boolean }) {
  if (queue) {
    if (t.turn === 'ADMIN') return <span className="tk-turn">{t.lastReply?.fromRequester ? 'New reply' : 'New'}</span>;
    return null;
  }
  if (t.status === 'WAITING_ON_USER') return <span className="tk-turn">Reply needed</span>;
  if (t.status === 'RESOLVED') return <span className="tk-turn">Confirm fix</span>;
  return null;
}

function TicketRow({ t, tz, queue, onOpen }: { t: TicketSummaryDto; tz: string; queue: boolean; onOpen: () => void }) {
  const Icon = CATEGORY_ICON[t.category];
  return (
    <li>
      <button type="button" className={t.status === 'CLOSED' ? 'tk-row tk-row--closed' : 'tk-row'} onClick={onOpen}>
        <span className="tk-row__icon" aria-hidden><Icon size={16} strokeWidth={1.8} /></span>
        <span className="tk-row__main">
          <span className="tk-row__title">
            <span className="tk-row__num">#{t.number}</span>
            <span className="tk-row__subject">{t.subject}</span>
            <TurnBadge t={t} queue={queue} />
          </span>
          <span className="tk-row__preview">
            {t.lastReply ? (
              <>
                <strong>{t.lastReply.by.split(' ')[0]}:</strong> {t.lastReply.snippet}
              </>
            ) : (
              <span className="tk-row__quiet">{queue ? 'No reply yet' : 'Waiting for an admin to pick it up'}</span>
            )}
          </span>
          <span className="tk-row__meta">
            <span>{TICKET_CATEGORY_LABEL[t.category]}</span>
            {queue && <span>{t.requester.name}</span>}
            {t.source === 'LARK' && <span>via Lark</span>}
            {t.source === 'ADMIN' && <span>opened by admin</span>}
            <span title={formatTicketTime(t.updatedAt, tz)}>{timeAgo(t.updatedAt, tz)}</span>
          </span>
        </span>
        <span className="tk-row__side">
          <span className="tk-row__tags">
            {(t.priority === 'HIGH' || t.priority === 'URGENT') && <Tag status={TICKET_PRIORITY_TONE[t.priority]}>{TICKET_PRIORITY_LABEL[t.priority]}</Tag>}
            <Tag status={TICKET_STATUS_TONE[t.status]} dot>{TICKET_STATUS_LABEL[t.status]}</Tag>
          </span>
          {queue && (
            <span className="tk-row__assignee ui-t-small">
              {t.assignee ? (
                <><Avatar name={t.assignee.name} src={t.assignee.avatarUrl ?? undefined} size={24} /> {t.assignee.name.split(' ')[0]}</>
              ) : (
                <span className="tk-row__quiet">Unassigned</span>
              )}
            </span>
          )}
        </span>
        <ArrowRight className="tk-row__go" size={16} strokeWidth={1.8} aria-hidden />
      </button>
    </li>
  );
}

function HowItWorks({ onCreate, queue }: { onCreate: () => void; queue: boolean }) {
  const steps = [
    { Icon: Send, title: 'Tell us what is wrong', body: 'Here, or message the Timo bot on Lark starting with “ticket”. Add a screenshot if you can.' },
    { Icon: MessageSquareText, title: 'An admin replies', body: 'Every reply reaches you on Lark. Reply to that message, or here, to answer.' },
    { Icon: LifeBuoy, title: 'Confirm the fix', body: 'Once it is resolved you are asked if it works. “Still a problem” sends it back.' },
  ];
  return (
    <Card className="tk-how">
      <div className="tk-how__head">
        <span className="ui-t-eyebrow">{queue ? 'Queue is empty' : 'How support works'}</span>
        <h2 className="tk-how__title">{queue ? 'Nothing waiting. Nice.' : 'Something not right? We will sort it out.'}</h2>
      </div>
      <ol className="tk-how__steps">
        {steps.map(({ Icon, title, body }, i) => (
          <li key={title} className="tk-how__step">
            <span className="tk-how__num ui-t-eyebrow">0{i + 1}</span>
            <Icon size={20} strokeWidth={1.6} aria-hidden />
            <span className="ui-t-strong">{title}</span>
            <span className="ui-t-small">{body}</span>
          </li>
        ))}
      </ol>
      <div>
        <Button variant="primary" icon={<Plus size={14} strokeWidth={2} />} onClick={onCreate}>Open a ticket</Button>
      </div>
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
        <Field label="What is it about?">
          <div className="tk-cats" role="radiogroup" aria-label="Category">
            {TICKET_CATEGORIES.map((c) => {
              const Icon = CATEGORY_ICON[c];
              const on = category === c;
              return (
                <button key={c} type="button" role="radio" aria-checked={on} className={on ? 'tk-cat tk-cat--on' : 'tk-cat'} onClick={() => setCategory(c)}>
                  <Icon size={16} strokeWidth={1.8} aria-hidden />
                  <span className="tk-cat__label">{TICKET_CATEGORY_LABEL[c]}</span>
                  <span className="tk-cat__hint">{CATEGORY_HINT[c]}</span>
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
