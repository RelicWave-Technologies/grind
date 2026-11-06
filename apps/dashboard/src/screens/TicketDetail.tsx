import './tickets.css';
import { useState } from 'react';
import { Link, useParams, useRouteContext } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  Lock,
  MessageCircleQuestion,
  RotateCcw,
  Send,
  UserCheck,
} from 'lucide-react';
import {
  TICKET_CATEGORIES,
  TICKET_CATEGORY_LABEL,
  TICKET_CLOSE_REASON_LABEL,
  TICKET_PRIORITIES,
  TICKET_PRIORITY_LABEL,
  TICKET_STATUS_LABEL,
  type TicketActionRequest,
  type TicketStatus,
  type TicketCategory,
  type TicketDetailDto,
  type TicketEventDto,
  type TicketPersonDto,
  type TicketPriority,
} from '@grind/types';
import { api } from '../lib/api';
import { ticketAssigneesQuery, ticketDetailQuery, ticketQueryKeys } from '../lib/queries';
import { TicketAttachmentList, useTicketUploads } from '../components/TicketAttachments';
import {
  Avatar,
  Banner,
  Button,
  Card,
  Checkbox,
  Field,
  Input,
  Modal,
  Page,
  Select,
  Skeleton,
  Tag,
  Textarea,
} from '../ui';
import { DropZone, StatusIcon, TICKET_PRIORITY_TONE, formatTicketTime, timeAgo } from './Tickets';

const ERRORS: Record<string, string> = {
  invalid_transition: 'The ticket changed meanwhile. It has been refreshed.',
  reopen_window_passed: 'This ticket closed more than 7 days ago. Open a new one.',
  ticket_closed: 'This ticket is closed. Reopen it to reply.',
  duplicate_invalid: 'No other ticket has that number.',
  assignee_invalid: 'Only an active admin can be assigned.',
  attachment_invalid: 'An attachment could not be added. Upload it again.',
  forbidden: 'You cannot do that on this ticket.',
};

function errorText(err: unknown): string {
  const code = (err as { body?: { error?: string } } | null)?.body?.error;
  return (code && ERRORS[code]) ?? (err instanceof Error ? err.message : 'Something went wrong');
}

const first = (name: string) => name.split(' ')[0] ?? name;

/** One ticket: where it stands, the conversation, and what to do next. */
export function TicketDetailScreen() {
  const { ticketId } = useParams({ from: '/authed/tickets/$ticketId' });
  const { me } = useRouteContext({ from: '/authed' });
  const qc = useQueryClient();
  const q = useQuery({ ...ticketDetailQuery<TicketDetailDto>(ticketId), refetchInterval: 30_000 });
  const t = q.data;
  const tz = me.workspaceTimezone;

  const onSaved = (next: TicketDetailDto) => {
    qc.setQueryData(ticketDetailQuery(ticketId).queryKey, next);
    void qc.invalidateQueries({ queryKey: ['tickets', 'list'] });
  };
  const act = useMutation({
    mutationFn: (body: TicketActionRequest) => api<TicketDetailDto>(`/v1/tickets/${ticketId}/actions`, { method: 'POST', json: body }),
    onSuccess: onSaved,
    onError: () => void qc.invalidateQueries({ queryKey: ticketQueryKeys.detail(ticketId) }),
  });

  if (q.isError) {
    const notFound = (q.error as { status?: number }).status === 404;
    return (
      <Page className="tk-page">
        <BackLink />
        <Banner status="danger">{notFound ? 'This ticket does not exist, or it is not yours to see.' : `Couldn’t load the ticket: ${(q.error as Error).message}`}</Banner>
      </Page>
    );
  }
  if (!t) {
    return (
      <Page className="tk-page">
        <BackLink />
        <Skeleton w={420} h={28} />
        <Card><Skeleton w={600} h={160} /></Card>
      </Page>
    );
  }

  const isRequester = t.requester.id === me.id;
  const nameOf = (p: TicketPersonDto) => (p.id === me.id ? 'you' : p.name);
  // Files on the opening message: those not attached to a later reply.
  const replyFiles = new Set(t.events.flatMap((e) => (e.kind === 'CREATED' ? [] : e.attachments.map((a) => a.id))));

  return (
    <Page className="tk-page">
      <BackLink />

      <header className="tk-head">
        <span className="ui-t-eyebrow">#{t.number} · {TICKET_CATEGORY_LABEL[t.category]}{t.source === 'LARK' ? ' · via Lark' : ''}</span>
        <h1 className="tk-head__title">{t.subject}</h1>
        <div className="tk-head__meta">
          <Avatar name={t.createdBy.name} src={t.createdBy.avatarUrl ?? undefined} size={24} />
          <span>
            {t.createdBy.id === t.requester.id ? (
              <><strong>{isRequester ? 'You' : t.requester.name}</strong> opened this</>
            ) : (
              <><strong>{t.createdBy.id === me.id ? 'You' : t.createdBy.name}</strong> opened this for <strong>{nameOf(t.requester)}</strong></>
            )}{' '}
            <span title={formatTicketTime(t.createdAt, tz)}>{timeAgo(t.createdAt, tz)}</span>
          </span>
          {t.priority !== 'NORMAL' && <Tag status={TICKET_PRIORITY_TONE[t.priority]}>{TICKET_PRIORITY_LABEL[t.priority]} priority</Tag>}
          {t.duplicateOf && (
            <Link to="/tickets/$ticketId" params={{ ticketId: t.duplicateOf.id }} className="tk-linkish">
              Duplicate of #{t.duplicateOf.number}
            </Link>
          )}
        </div>
      </header>

      <section className={`tk-state tk-state--${STATE_TONE[t.status]}`} aria-label="Where this ticket stands">
        <span className="tk-state__icon"><StatusIcon status={t.status} size={20} /></span>
        <div className="tk-state__text">
          <span className="tk-state__title">{stateCopy(t, isRequester).title}</span>
          <span className="tk-state__sub">{stateCopy(t, isRequester).sub}</span>
        </div>
        <HeaderActions key={t.id} t={t} isRequester={isRequester} busy={act.isPending} onAct={(a) => act.mutate(a)} />
      </section>

      {act.isError && <Banner status="danger">{errorText(act.error)}</Banner>}
      {t.requesterUnreachable && t.can.manage && (
        <Banner status="warn">Timo cannot message {first(t.requester.name)} on Lark, so they only see replies here.</Banner>
      )}

      <div className="tk-layout">
        <div className="tk-main">
          <section className="tk-feed" aria-label="Conversation">
            <Comment
              who={t.createdBy}
              support={t.createdBy.id !== t.requester.id}
              at={t.createdAt}
              tz={tz}
              note={t.createdBy.id !== t.requester.id ? `opened this for ${nameOf(t.requester)}` : 'opened the ticket'}
              lead
            >
              <p className="tk-body">{t.description}</p>
              <TicketAttachmentList items={t.attachments.filter((a) => !replyFiles.has(a.id))} />
            </Comment>
            {compactFeed(t.events).map(({ e, asked }) => (
              <EventItem key={e.id} e={e} tz={tz} requesterId={t.requester.id} meId={me.id} asked={asked} />
            ))}
            {t.can.comment ? (
              <div className="tk-feed__item">
                <span className="tk-feed__rail"><Avatar name={me.name} src={me.avatarUrl ?? undefined} size={32} /></span>
                <Composer key={t.id} t={t} onSaved={onSaved} />
              </div>
            ) : null}
          </section>
        </div>
        <aside className="tk-side">
          <DetailsCard key={t.id} t={t} tz={tz} isRequester={isRequester} busy={act.isPending} onAct={(a) => act.mutate(a)} />
        </aside>
      </div>
    </Page>
  );
}

function BackLink() {
  return (
    <Link to="/tickets" className="tk-back ui-t-small">
      <ArrowLeft size={14} strokeWidth={1.8} /> Tickets
    </Link>
  );
}

/** The moves the viewer can make right now, as a few buttons by the title. */
function HeaderActions({ t, isRequester, busy, onAct }: { t: TicketDetailDto; isRequester: boolean; busy: boolean; onAct: (a: TicketActionRequest) => void }) {
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState('');
  const active = t.status === 'OPEN' || t.status === 'IN_PROGRESS' || t.status === 'WAITING_ON_USER';
  return (
    <div className="tk-head__actions">
      {t.can.confirm && (
        <>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => {
              onAct({ action: 'reopen', note: 'Still a problem' });
              // Next thing they want is to say what is still wrong.
              document.getElementById('tk-reply')?.focus();
            }}
          >
            Still a problem
          </Button>
          <Button variant="primary" loading={busy} onClick={() => onAct({ action: 'confirm' })}>Yes, it is fixed</Button>
        </>
      )}
      {isRequester && !t.can.manage && !t.can.confirm && t.can.reopen && (
        <Button variant="secondary" icon={<RotateCcw size={14} strokeWidth={1.8} />} loading={busy} onClick={() => onAct({ action: 'reopen' })}>Reopen</Button>
      )}
      {isRequester && t.can.withdraw && !t.can.confirm && (
        <Button variant="ghost" disabled={busy} onClick={() => setConfirmWithdraw(true)}>Withdraw</Button>
      )}
      {t.can.manage && active && !t.assignee && (
        <Button variant="secondary" icon={<UserCheck size={14} strokeWidth={1.8} />} disabled={busy} onClick={() => onAct({ action: 'start' })}>Take it</Button>
      )}
      {t.can.manage && active && (
        <Button variant="primary" icon={<Check size={14} strokeWidth={2} />} disabled={busy} onClick={() => setResolving(true)}>Resolve</Button>
      )}
      {t.can.manage && !active && (
        <Button variant="secondary" icon={<RotateCcw size={14} strokeWidth={1.8} />} disabled={busy} onClick={() => onAct({ action: 'reopen' })}>Reopen</Button>
      )}

      <Modal
        open={confirmWithdraw}
        onClose={() => setConfirmWithdraw(false)}
        title={`Withdraw #${t.number}?`}
        description="The ticket closes. You can reopen it within 7 days."
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirmWithdraw(false)}>Keep it</Button>
            <Button variant="danger" onClick={() => { setConfirmWithdraw(false); onAct({ action: 'withdraw' }); }}>Withdraw</Button>
          </>
        }
      />
      <Modal
        open={resolving}
        onClose={() => setResolving(false)}
        title={`Resolve #${t.number}`}
        description={`${first(t.requester.name)} is asked on Lark to confirm it works. It closes by itself after 3 days without an answer.`}
        actions={
          <>
            <Button variant="secondary" onClick={() => setResolving(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => { setResolving(false); onAct({ action: 'resolve', note: note.trim() || undefined }); setNote(''); }}>Resolve</Button>
          </>
        }
      >
        <Field label="What was done (they see this)">
          <Textarea rows={3} value={note} maxLength={5000} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Restored your Tuesday entry." autoFocus />
        </Field>
      </Modal>
    </div>
  );
}

function Comment({
  who,
  support,
  at,
  tz,
  note,
  internal,
  via,
  lead,
  chip,
  children,
}: {
  who: TicketPersonDto | null;
  support?: boolean;
  at: string;
  tz: string;
  note?: string;
  internal?: boolean;
  via?: string;
  lead?: boolean;
  /** A small chip after the name: "Question", "Fix", … */
  chip?: { label: string; tone: 'ask' | 'fix' | 'closed' };
  children?: React.ReactNode;
}) {
  const cls = ['tk-comment', internal && 'tk-comment--internal', support && !internal && 'tk-comment--support', lead && 'tk-comment--lead'].filter(Boolean).join(' ');
  return (
    <article className="tk-feed__item">
      <span className="tk-feed__rail"><Avatar name={who?.name ?? 'Timo'} src={who?.avatarUrl ?? undefined} size={32} /></span>
      <div className={cls}>
        <div className="tk-comment__head">
          <span className="tk-comment__name">{who?.name ?? 'Timo'}</span>
          {support && !internal && <span className="tk-comment__role">Support</span>}
          {internal && <span className="tk-comment__role tk-comment__role--note"><Lock size={10} strokeWidth={2.4} aria-hidden /> Internal note</span>}
          {chip && <span className={`tk-comment__chip tk-comment__chip--${chip.tone}`}>{chip.label}</span>}
          {note && <span className="tk-comment__note">{note}</span>}
          <span className="tk-comment__time" title={formatTicketTime(at, tz)}>{timeAgo(at, tz)}{via ? ` · ${via}` : ''}</span>
        </div>
        <div className="tk-comment__body">{children}</div>
      </div>
    </article>
  );
}

function EventItem({ e, tz, requesterId, meId, asked }: { e: TicketEventDto; tz: string; requesterId: string; meId: string; asked?: boolean }) {
  if (e.kind === 'COMMENT' || e.kind === 'INTERNAL_NOTE') {
    return (
      <Comment
        who={e.actor}
        support={e.actor?.id !== requesterId}
        at={e.createdAt}
        tz={tz}
        internal={e.kind === 'INTERNAL_NOTE'}
        via={e.via === 'LARK' ? 'on Lark' : undefined}
        chip={asked ? { label: 'Question', tone: 'ask' } : undefined}
      >
        {e.body && e.body !== '(attachment)' && <p className="tk-body">{e.body}</p>}
        <TicketAttachmentList items={e.attachments} />
      </Comment>
    );
  }
  // A resolution or closing note is something the requester reads: give it a card.
  if (e.kind === 'STATUS' && e.body && (e.toStatus === 'RESOLVED' || e.toStatus === 'CLOSED')) {
    return (
      <Comment
        who={e.actor}
        support={e.actor?.id !== requesterId}
        at={e.createdAt}
        tz={tz}
        via={e.via === 'LARK' ? 'on Lark' : undefined}
        chip={e.toStatus === 'RESOLVED' ? { label: 'Resolved', tone: 'fix' } : { label: 'Closed', tone: 'closed' }}
      >
        <p className="tk-body">{e.body}</p>
      </Comment>
    );
  }
  let line = '';
  if (e.kind === 'STATUS') {
    const reason = e.meta?.closeReason as keyof typeof TICKET_CLOSE_REASON_LABEL | undefined;
    const reopened = (e.fromStatus === 'RESOLVED' || e.fromStatus === 'CLOSED') && e.toStatus !== 'CLOSED' && e.toStatus !== 'RESOLVED';
    line = e.toStatus === 'CLOSED'
      ? reason === 'WITHDRAWN' ? 'withdrew it'
        : reason === 'USER_CONFIRMED' ? 'confirmed it is fixed'
        : reason ? `closed it · ${TICKET_CLOSE_REASON_LABEL[reason]}` : 'closed it'
      : reopened ? 'reopened it' : `moved it to ${e.toStatus ? TICKET_STATUS_LABEL[e.toStatus] : '?'}`;
  } else if (e.kind === 'ASSIGNED') {
    line = e.meta?.assigneeId ? (e.meta.assigneeId === e.actor?.id ? 'took it' : 'assigned it') : 'unassigned it';
  } else if (e.kind === 'PRIORITY') {
    line = e.meta?.to
      ? `set priority to ${TICKET_PRIORITY_LABEL[e.meta.to as TicketPriority]}`
      : e.meta?.categoryTo ? `moved it to ${TICKET_CATEGORY_LABEL[e.meta.categoryTo as TicketCategory]}` : 'changed it';
  }
  return (
    <div className="tk-feed__item tk-feed__item--sys">
      <span className="tk-feed__rail">
        <span className="tk-feed__dot">{e.kind === 'STATUS' && e.toStatus ? <StatusIcon status={e.toStatus} size={14} /> : <UserCheck size={12} strokeWidth={2} aria-hidden />}</span>
      </span>
      <div className="tk-sys">
        <span><strong>{e.actor ? (e.actor.id === meId ? 'You' : e.actor.name) : 'Timo'}</strong> {line}{e.via === 'LARK' ? ' on Lark' : ''} · <span title={formatTicketTime(e.createdAt, tz)}>{timeAgo(e.createdAt, tz)}</span></span>
        {e.body && <p className="tk-sys__note">{e.body}</p>}
      </div>
    </div>
  );
}

function Composer({ t, onSaved }: { t: TicketDetailDto; onSaved: (t: TicketDetailDto) => void }) {
  const [body, setBody] = useState('');
  // On a closed ticket an admin is usually leaving a note, not writing to the requester.
  const [internal, setInternal] = useState(t.status === 'CLOSED' && t.can.manage);
  const uploads = useTicketUploads();
  const send = useMutation({
    mutationFn: (opts: { askUser: boolean }) =>
      api<TicketDetailDto>(`/v1/tickets/${t.id}/comments`, {
        method: 'POST',
        json: { body: body.trim() || '(attachment)', internal, askUser: opts.askUser && !internal, attachmentIds: uploads.ids },
      }),
    onSuccess: (next) => {
      setBody('');
      setInternal(t.status === 'CLOSED' && t.can.manage);
      uploads.clear();
      onSaved(next);
    },
  });
  const ready = (body.trim().length > 0 || uploads.ids.length > 0) && !uploads.busy && !send.isPending;
  const canAsk = t.can.manage && !internal && t.status !== 'CLOSED';
  const placeholder = internal
    ? t.status === 'CLOSED' ? 'Closed. Add a note only admins see, or reopen it to work on it again.' : 'Only admins see this note.'
    : t.can.manage
      ? `Write to ${first(t.requester.name)}. They get it on Lark.`
      : t.status === 'RESOLVED'
        ? 'Still a problem? Say what is still wrong.'
        : t.status === 'WAITING_ON_USER'
          ? `Answer ${t.assignee ? first(t.assignee.name) : 'support'} here. They get it on Lark.`
          : 'Add anything that helps: dates, times, screenshots.';

  return (
    <div className={internal ? 'tk-compose tk-compose--internal' : 'tk-compose'}>
      <Textarea
        id="tk-reply"
        rows={3}
        maxLength={5000}
        value={body}
        placeholder={placeholder}
        onChange={(e) => setBody(e.target.value)}
        onPaste={uploads.onPaste}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && ready) {
            e.preventDefault();
            send.mutate({ askUser: false });
          }
        }}
      />
      <DropZone uploads={uploads} compact />
      {send.isError && <Banner status="danger">{errorText(send.error)}</Banner>}
      <div className="tk-compose__bar">
        {t.can.manage && (
          <label className="tk-check ui-t-small">
            <Checkbox checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note
          </label>
        )}
        <span className="tk-compose__hint ui-t-small">⌘/Ctrl + Enter to send</span>
        {canAsk && (
          <Button
            variant="secondary"
            icon={<MessageCircleQuestion size={14} strokeWidth={1.8} />}
            disabled={!ready}
            loading={send.isPending && send.variables?.askUser}
            onClick={() => send.mutate({ askUser: true })}
            title="Send as a question: the ticket waits on them and they are reminded"
          >
            Ask {first(t.requester.name)}
          </Button>
        )}
        <Button
          variant="primary"
          icon={<Send size={14} strokeWidth={1.8} />}
          disabled={!ready}
          loading={send.isPending && !send.variables?.askUser}
          onClick={() => send.mutate({ askUser: false })}
        >
          {internal ? 'Save note' : 'Send'}
        </Button>
      </div>
    </div>
  );
}

function DetailsCard({ t, tz, isRequester, busy, onAct }: { t: TicketDetailDto; tz: string; isRequester: boolean; busy: boolean; onAct: (a: TicketActionRequest) => void }) {
  const assigneesQ = useQuery({ ...ticketAssigneesQuery<{ assignees: TicketPersonDto[] }>(), enabled: t.can.manage });
  const [dupOf, setDupOf] = useState('');
  const [dupOpen, setDupOpen] = useState(false);
  // A closed ticket's facts are history: shown, not edited (reopen to change them).
  const editable = t.can.manage && t.status !== 'CLOSED';

  return (
    <div className="tk-side__stack">
      <Card className="tk-details">
        <dl className="tk-facts">
          {!isRequester && <dt>Requester</dt>}
          {!isRequester && <dd className="tk-person">
            <Avatar name={t.requester.name} src={t.requester.avatarUrl ?? undefined} size={32} />
            <span className="tk-person__text">
              <span className="ui-t-strong">{t.requester.name}</span>
              <span className="ui-t-small">{t.requester.email}</span>
            </span>
          </dd>}
          <dt>{isRequester ? 'Handled by' : 'Assignee'}</dt>
          <dd>
            {editable ? (
              <Select aria-label="Assignee" value={t.assignee?.id ?? ''} disabled={busy} onChange={(e) => onAct({ action: 'assign', assigneeId: e.target.value || null })}>
                <option value="">Unassigned</option>
                {(assigneesQ.data?.assignees ?? (t.assignee ? [t.assignee] : [])).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
            ) : (t.assignee?.name ?? (t.status === 'CLOSED' ? 'Nobody' : 'Not picked up yet'))}
          </dd>
          {t.can.manage && (
            <>
              <dt>Priority</dt>
              <dd>
                {editable ? (
                  <Select aria-label="Priority" value={t.priority} disabled={busy} onChange={(e) => onAct({ action: 'priority', priority: e.target.value as TicketPriority })}>
                    {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{TICKET_PRIORITY_LABEL[p]}</option>)}
                  </Select>
                ) : TICKET_PRIORITY_LABEL[t.priority]}
              </dd>
              <dt>Category</dt>
              <dd>
                {editable ? (
                  <Select aria-label="Category" value={t.category} disabled={busy} onChange={(e) => onAct({ action: 'category', category: e.target.value as TicketCategory })}>
                    {TICKET_CATEGORIES.map((c) => <option key={c} value={c}>{TICKET_CATEGORY_LABEL[c]}</option>)}
                  </Select>
                ) : TICKET_CATEGORY_LABEL[t.category]}
              </dd>
            </>
          )}
        </dl>
        <ul className="tk-timeline">
          <li><span>Opened</span><span>{formatTicketTime(t.createdAt, tz)}</span></li>
          {t.resolvedAt && <li><span>Resolved</span><span>{formatTicketTime(t.resolvedAt, tz)}</span></li>}
          {t.closedAt && <li><span>Closed</span><span>{formatTicketTime(t.closedAt, tz)}</span></li>}
          <li><span>Last activity</span><span>{timeAgo(t.updatedAt, tz)}</span></li>
        </ul>
        {t.can.manage && t.status !== 'CLOSED' && (
          <div className="tk-minor">
            <button type="button" className="tk-linkish ui-t-small" disabled={busy} onClick={() => setDupOpen(true)}>Duplicate of…</button>
            <button type="button" className="tk-linkish ui-t-small" disabled={busy} onClick={() => onAct({ action: 'close' })}>Close without resolving</button>
          </div>
        )}
      </Card>

      <Modal
        open={dupOpen}
        onClose={() => setDupOpen(false)}
        title={`Close #${t.number} as a duplicate`}
        description={`${first(t.requester.name)} is told which ticket to follow.`}
        actions={
          <>
            <Button variant="secondary" onClick={() => setDupOpen(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!/^\d+$/u.test(dupOf.replace('#', ''))}
              onClick={() => { setDupOpen(false); onAct({ action: 'duplicate', ofNumber: Number(dupOf.replace('#', '')) }); setDupOf(''); }}
            >
              Close as duplicate
            </Button>
          </>
        }
      >
        <Field label="Original ticket number">
          <Input value={dupOf} placeholder="#12" onChange={(e) => setDupOf(e.target.value)} autoFocus />
        </Field>
      </Modal>
    </div>
  );
}

const STATE_TONE: Record<TicketStatus, string> = {
  OPEN: 'open',
  IN_PROGRESS: 'progress',
  WAITING_ON_USER: 'waiting',
  RESOLVED: 'resolved',
  CLOSED: 'closed',
};

/** The one sentence that says where the ticket stands and whose move it is. */
function stateCopy(t: TicketDetailDto, isRequester: boolean): { title: string; sub: string } {
  const req = first(t.requester.name);
  const who = t.assignee ? first(t.assignee.name) : null;
  const closed = t.closeReason ? TICKET_CLOSE_REASON_LABEL[t.closeReason] : 'No more replies expected.';
  const reopenHint = t.can.reopen ? ' Reopen it if the problem is back.' : '';
  const closedForYou: Record<string, string> = {
    USER_CONFIRMED: 'You confirmed it is fixed.',
    AUTO_CONFIRMED: 'Closed after 3 days without an answer to “is it fixed?”.',
    WITHDRAWN: 'You withdrew it.',
    DUPLICATE: `Closed as a duplicate${t.duplicateOf ? ` of #${t.duplicateOf.number}` : ''}. Follow that one.`,
    NO_RESPONSE: 'Closed after 5 days without your answer.',
    ADMIN: 'Support closed it.',
  };
  if (t.can.manage && !isRequester) {
    switch (t.status) {
      case 'OPEN':
        return who
          ? { title: 'Needs a reply', sub: `${req} is waiting. ${who} has it.` }
          : { title: 'Needs a reply', sub: `${req} is waiting and nobody has picked it up yet.` };
      case 'IN_PROGRESS':
        return t.turn === 'ADMIN'
          ? { title: 'Needs a reply', sub: `${req} wrote back. ${who ?? 'Nobody'} is on it.` }
          : { title: 'In progress', sub: `${who ?? 'Support'} is working on it.` };
      case 'WAITING_ON_USER':
        return { title: `Waiting on ${req}`, sub: 'You asked a question. Timo reminds them on Lark.' };
      case 'RESOLVED':
        return { title: 'Resolved', sub: `${req} is asked to confirm. It closes by itself after 3 days.` };
      default:
        return { title: 'Closed', sub: closed };
    }
  }
  switch (t.status) {
    case 'OPEN':
      return { title: 'With support', sub: 'An admin replies here and on Lark.' };
    case 'IN_PROGRESS':
      return { title: `${who ?? 'Support'} is on it`, sub: 'You get every reply on Lark too.' };
    case 'WAITING_ON_USER':
      return { title: `${who ?? 'Support'} asked you something`, sub: 'Reply below or on Lark.' };
    case 'RESOLVED':
      return { title: 'Is it fixed?', sub: 'Tell us if it works, or say what is still wrong.' };
    default:
      return { title: 'Closed', sub: (t.closeReason ? closedForYou[t.closeReason] ?? closed : closed) + reopenHint };
  }
}

/**
 * Drop status lines that only repeat the line next to them: "took it" already
 * says it moved to In progress, and a question already says it now waits on
 * the requester (that comment gets a "Question" chip instead).
 */
function compactFeed(events: TicketEventDto[]): Array<{ e: TicketEventDto; asked: boolean }> {
  const list = events.filter((e) => e.kind !== 'CREATED');
  const near = (a: TicketEventDto, b: TicketEventDto | undefined) =>
    Boolean(b) && a.actor?.id === b!.actor?.id && Math.abs(new Date(a.createdAt).getTime() - new Date(b!.createdAt).getTime()) < 10_000;
  const out: Array<{ e: TicketEventDto; asked: boolean }> = [];
  list.forEach((e, i) => {
    const prev = list[i - 1];
    const next = list[i + 1];
    if (e.kind === 'STATUS' && e.toStatus === 'IN_PROGRESS' && !e.body &&
        ((prev?.kind === 'ASSIGNED' && near(e, prev)) || (next?.kind === 'ASSIGNED' && near(e, next)) ||
         // A requester's reply moves it back by itself; the reply says enough.
         (prev?.kind === 'COMMENT' && near(e, prev)))) return;
    if (e.kind === 'STATUS' && e.toStatus === 'WAITING_ON_USER' && !e.body && prev?.kind === 'COMMENT' && near(e, prev)) {
      const last = out[out.length - 1];
      if (last && last.e.id === prev.id) last.asked = true;
      return;
    }
    out.push({ e, asked: false });
  });
  return out;
}
