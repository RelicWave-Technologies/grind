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
import { DropZone, TICKET_PRIORITY_TONE, TICKET_STATUS_TONE, formatTicketTime, timeAgo } from './Tickets';

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
  // Files on the opening message: those not attached to a later reply.
  const replyFiles = new Set(t.events.flatMap((e) => (e.kind === 'CREATED' ? [] : e.attachments.map((a) => a.id))));

  return (
    <Page className="tk-page">
      <BackLink />

      <header className="tk-head">
        <div className="tk-head__text">
          <span className="ui-t-eyebrow">#{t.number} · {TICKET_CATEGORY_LABEL[t.category]}{t.source === 'LARK' ? ' · via Lark' : ''}</span>
          <h1 className="tk-head__title">{t.subject}</h1>
          <div className="tk-head__meta">
            <Tag status={TICKET_STATUS_TONE[t.status]}>{TICKET_STATUS_LABEL[t.status]}</Tag>
            {t.priority !== 'NORMAL' && <Tag status={TICKET_PRIORITY_TONE[t.priority]}>{TICKET_PRIORITY_LABEL[t.priority]}</Tag>}
            {t.closeReason && <span className="ui-t-small">{TICKET_CLOSE_REASON_LABEL[t.closeReason]}</span>}
            {t.duplicateOf && (
              <Link to="/tickets/$ticketId" params={{ ticketId: t.duplicateOf.id }} className="ui-t-small tk-linkish">
                Duplicate of #{t.duplicateOf.number}
              </Link>
            )}
          </div>
        </div>
        <HeaderActions t={t} isRequester={isRequester} busy={act.isPending} onAct={(a) => act.mutate(a)} />
      </header>

      {act.isError && <Banner status="danger">{errorText(act.error)}</Banner>}
      {isRequester && t.status === 'WAITING_ON_USER' && (
        <Banner status="warn">{t.assignee ? first(t.assignee.name) : 'An admin'} asked you something. Reply below or on Lark.</Banner>
      )}
      {isRequester && t.status === 'RESOLVED' && (
        <Banner status="success">Marked resolved. Is it fixed? Use the buttons above.</Banner>
      )}
      {t.requesterUnreachable && t.can.manage && (
        <Banner status="warn">Timo cannot message {first(t.requester.name)} on Lark, so they only see replies here.</Banner>
      )}

      <div className="tk-layout">
        <div className="tk-main">
          <section className="tk-thread" aria-label="Comments">
            <Comment
              who={t.createdBy}
              support={t.createdBy.id !== t.requester.id}
              at={t.createdAt}
              tz={tz}
              note={t.createdBy.id !== t.requester.id ? `opened this for ${t.requester.name}` : undefined}
            >
              <p className="tk-body">{t.description}</p>
              <TicketAttachmentList items={t.attachments.filter((a) => !replyFiles.has(a.id))} />
            </Comment>
            {t.events.filter((e) => e.kind !== 'CREATED').map((e) => (
              <EventItem key={e.id} e={e} tz={tz} requesterId={t.requester.id} />
            ))}
          </section>
          {t.can.comment ? (
            <Composer t={t} onSaved={onSaved} />
          ) : t.status === 'CLOSED' && !t.can.manage ? (
            <div className="tk-closed-note ui-t-small">
              <Lock size={14} strokeWidth={1.8} aria-hidden />
              This ticket is closed.{t.can.reopen ? ' Reopen it if the problem is back.' : ' Open a new ticket if you need more help.'}
            </div>
          ) : null}
        </div>
        <aside className="tk-side">
          <DetailsCard t={t} tz={tz} busy={act.isPending} onAct={(a) => act.mutate(a)} />
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
          <Button variant="secondary" disabled={busy} onClick={() => onAct({ action: 'reopen', note: 'Still a problem' })}>Still a problem</Button>
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
  children,
}: {
  who: TicketPersonDto | null;
  support?: boolean;
  at: string;
  tz: string;
  note?: string;
  internal?: boolean;
  via?: string;
  children?: React.ReactNode;
}) {
  return (
    <article className={internal ? 'tk-comment tk-comment--internal' : 'tk-comment'}>
      <Avatar name={who?.name ?? 'Timo'} src={who?.avatarUrl ?? undefined} size={32} />
      <div className="tk-comment__body">
        <div className="tk-comment__head">
          <span className="ui-t-strong">{who?.name ?? 'Timo'}</span>
          {support && !internal && <span className="tk-comment__role">Support</span>}
          {internal && <span className="tk-comment__role tk-comment__role--note">Internal note</span>}
          {note && <span className="ui-t-small tk-comment__note">{note}</span>}
          <span className="tk-comment__time" title={formatTicketTime(at, tz)}>{timeAgo(at, tz)}{via ? ` · ${via}` : ''}</span>
        </div>
        {children}
      </div>
    </article>
  );
}

function EventItem({ e, tz, requesterId }: { e: TicketEventDto; tz: string; requesterId: string }) {
  if (e.kind === 'COMMENT' || e.kind === 'INTERNAL_NOTE') {
    return (
      <Comment
        who={e.actor}
        support={e.actor?.id !== requesterId}
        at={e.createdAt}
        tz={tz}
        internal={e.kind === 'INTERNAL_NOTE'}
        via={e.via === 'LARK' ? 'on Lark' : undefined}
      >
        {e.body && e.body !== '(attachment)' && <p className="tk-body">{e.body}</p>}
        <TicketAttachmentList items={e.attachments} />
      </Comment>
    );
  }
  let line = '';
  if (e.kind === 'STATUS') {
    const reason = e.meta?.closeReason as keyof typeof TICKET_CLOSE_REASON_LABEL | undefined;
    line = e.toStatus === 'CLOSED' && reason ? `closed it · ${TICKET_CLOSE_REASON_LABEL[reason]}` : `moved it to ${e.toStatus ? TICKET_STATUS_LABEL[e.toStatus] : '?'}`;
  } else if (e.kind === 'ASSIGNED') {
    line = e.meta?.assigneeId ? (e.meta.assigneeId === e.actor?.id ? 'took it' : 'assigned it') : 'unassigned it';
  } else if (e.kind === 'PRIORITY') {
    line = e.meta?.to
      ? `set priority to ${TICKET_PRIORITY_LABEL[e.meta.to as TicketPriority]}`
      : e.meta?.categoryTo ? `moved it to ${TICKET_CATEGORY_LABEL[e.meta.categoryTo as TicketCategory]}` : 'changed it';
  }
  return (
    <div className="tk-sys ui-t-small">
      <span><strong>{e.actor?.name ?? 'Timo'}</strong> {line}{e.via === 'LARK' ? ' on Lark' : ''} · <span title={formatTicketTime(e.createdAt, tz)}>{timeAgo(e.createdAt, tz)}</span></span>
      {e.body && <p className="tk-sys__note">{e.body}</p>}
    </div>
  );
}

function Composer({ t, onSaved }: { t: TicketDetailDto; onSaved: (t: TicketDetailDto) => void }) {
  const [body, setBody] = useState('');
  const [internal, setInternal] = useState(false);
  const uploads = useTicketUploads();
  const send = useMutation({
    mutationFn: (opts: { askUser: boolean }) =>
      api<TicketDetailDto>(`/v1/tickets/${t.id}/comments`, {
        method: 'POST',
        json: { body: body.trim() || '(attachment)', internal, askUser: opts.askUser && !internal, attachmentIds: uploads.ids },
      }),
    onSuccess: (next) => {
      setBody('');
      setInternal(false);
      uploads.clear();
      onSaved(next);
    },
  });
  const ready = (body.trim().length > 0 || uploads.ids.length > 0) && !uploads.busy && !send.isPending;
  const canAsk = t.can.manage && !internal && t.status !== 'CLOSED';
  const placeholder = internal
    ? 'Only admins see this note.'
    : t.can.manage
      ? `Write to ${first(t.requester.name)}. They get it on Lark.`
      : t.status === 'RESOLVED' ? 'Still a problem? Say what is still wrong.' : 'Add details or answer the admin.';

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

function DetailsCard({ t, tz, busy, onAct }: { t: TicketDetailDto; tz: string; busy: boolean; onAct: (a: TicketActionRequest) => void }) {
  const assigneesQ = useQuery({ ...ticketAssigneesQuery<{ assignees: TicketPersonDto[] }>(), enabled: t.can.manage });
  const [dupOf, setDupOf] = useState('');
  const [dupOpen, setDupOpen] = useState(false);

  return (
    <div className="tk-side__stack">
      <Card title="Details" className="tk-details">
        <dl className="tk-facts">
          <dt>Requester</dt>
          <dd className="tk-person">
            <Avatar name={t.requester.name} src={t.requester.avatarUrl ?? undefined} size={24} />
            <span className="tk-person__text">
              <span className="ui-t-strong">{t.requester.name}</span>
              <span className="ui-t-small">{t.requester.email}</span>
            </span>
          </dd>
          <dt>Assignee</dt>
          <dd>
            {t.can.manage ? (
              <Select aria-label="Assignee" value={t.assignee?.id ?? ''} disabled={busy} onChange={(e) => onAct({ action: 'assign', assigneeId: e.target.value || null })}>
                <option value="">Unassigned</option>
                {(assigneesQ.data?.assignees ?? (t.assignee ? [t.assignee] : [])).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
            ) : (t.assignee?.name ?? 'Not picked up yet')}
          </dd>
          {t.can.manage && (
            <>
              <dt>Priority</dt>
              <dd>
                <Select aria-label="Priority" value={t.priority} disabled={busy} onChange={(e) => onAct({ action: 'priority', priority: e.target.value as TicketPriority })}>
                  {TICKET_PRIORITIES.map((p) => <option key={p} value={p}>{TICKET_PRIORITY_LABEL[p]}</option>)}
                </Select>
              </dd>
              <dt>Category</dt>
              <dd>
                <Select aria-label="Category" value={t.category} disabled={busy} onChange={(e) => onAct({ action: 'category', category: e.target.value as TicketCategory })}>
                  {TICKET_CATEGORIES.map((c) => <option key={c} value={c}>{TICKET_CATEGORY_LABEL[c]}</option>)}
                </Select>
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
