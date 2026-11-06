import './tickets.css';
import { useState } from 'react';
import { Link, useParams, useRouteContext } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
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
import { TicketAttachmentList, TicketUploadPicker, useTicketUploads } from '../components/TicketAttachments';
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
  PageHeader,
  Select,
  Skeleton,
  Tag,
  Textarea,
  Toolbar,
} from '../ui';
import { TICKET_PRIORITY_TONE, TICKET_STATUS_TONE, formatTicketTime } from './Tickets';

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

/** One ticket: the thread, the reply box, and (for admins) the controls. */
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
        <Card><Skeleton w={600} h={120} /></Card>
      </Page>
    );
  }

  return (
    <Page className="tk-page">
      <BackLink />
      <PageHeader
        eyebrow={`Ticket #${t.number} · ${TICKET_CATEGORY_LABEL[t.category]}`}
        title={t.subject}
        subtitle={
          <span className="tk-head-tags">
            <Tag status={TICKET_STATUS_TONE[t.status]} dot>{TICKET_STATUS_LABEL[t.status]}</Tag>
            {t.priority !== 'NORMAL' && <Tag status={TICKET_PRIORITY_TONE[t.priority]}>{TICKET_PRIORITY_LABEL[t.priority]}</Tag>}
            {t.closeReason && <span className="ui-t-small ui-ink-3">{TICKET_CLOSE_REASON_LABEL[t.closeReason]}</span>}
            {t.duplicateOf && (
              <Link to="/tickets/$ticketId" params={{ ticketId: t.duplicateOf.id }} className="ui-t-small">
                Duplicate of #{t.duplicateOf.number}
              </Link>
            )}
          </span>
        }
        actions={<RequesterActions t={t} busy={act.isPending} onAct={(a) => act.mutate(a)} />}
      />

      {act.isError && <Banner status="danger">{errorText(act.error)}</Banner>}
      {t.requesterUnreachable && t.can.manage && (
        <Banner status="warn">Timo cannot message {t.requester.name} on Lark (not in the bot’s availability, or never signed in with Lark). They will only see replies here.</Banner>
      )}
      {t.status === 'RESOLVED' && t.can.confirm && (
        <Banner status="success">An admin marked this resolved. Is it fixed? If not, choose “Still a problem”.</Banner>
      )}

      <div className="tk-layout">
        <div className="tk-main">
          <Card>
            <ThreadEntry who={t.createdBy} at={t.createdAt} tz={tz} note={t.createdBy.id !== t.requester.id ? `opened this for ${t.requester.name}` : 'opened this ticket'}>
              <p className="tk-body">{t.description}</p>
              <TicketAttachmentList items={t.attachments.filter((a) => !t.events.some((e) => e.kind !== 'CREATED' && e.attachments.some((x) => x.id === a.id)))} />
            </ThreadEntry>
            {t.events.filter((e) => e.kind !== 'CREATED').map((e) => <EventEntry key={e.id} e={e} tz={tz} />)}
          </Card>
          {t.can.comment && <Composer t={t} onSaved={onSaved} />}
          {!t.can.comment && t.status === 'CLOSED' && !t.can.manage && (
            <Banner status="info">This ticket is closed.{t.can.reopen ? ' Reopen it if the problem is back.' : ' Open a new ticket if you need more help.'}</Banner>
          )}
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
      <ArrowLeft size={14} strokeWidth={1.8} /> All tickets
    </Link>
  );
}

function ThreadEntry({ who, at, tz, note, children, internal }: { who: TicketPersonDto | null; at: string; tz: string; note?: string; children?: React.ReactNode; internal?: boolean }) {
  return (
    <div className={internal ? 'tk-entry tk-entry--internal' : 'tk-entry'}>
      <Avatar name={who?.name ?? 'Timo'} src={who?.avatarUrl ?? undefined} size={32} />
      <div className="tk-entry__body">
        <div className="tk-entry__head">
          <span className="ui-t-strong">{who?.name ?? 'Timo'}</span>
          {note && <span className="ui-t-small ui-ink-3">{note}</span>}
          {internal && <Tag status="warn">Internal note</Tag>}
          <span className="ui-t-small ui-ink-3 tk-entry__time">{formatTicketTime(at, tz)}</span>
        </div>
        {children}
      </div>
    </div>
  );
}

function EventEntry({ e, tz }: { e: TicketEventDto; tz: string }) {
  const via = e.via === 'LARK' ? ' on Lark' : '';
  if (e.kind === 'COMMENT' || e.kind === 'INTERNAL_NOTE') {
    return (
      <ThreadEntry who={e.actor} at={e.createdAt} tz={tz} internal={e.kind === 'INTERNAL_NOTE'} note={via ? `replied${via}` : undefined}>
        {e.body && <p className="tk-body">{e.body}</p>}
        <TicketAttachmentList items={e.attachments} />
      </ThreadEntry>
    );
  }
  let line = '';
  if (e.kind === 'STATUS') {
    const reason = (e.meta?.closeReason as keyof typeof TICKET_CLOSE_REASON_LABEL | undefined);
    line = e.toStatus === 'CLOSED' && reason
      ? `closed it: ${TICKET_CLOSE_REASON_LABEL[reason]}`
      : `moved it to ${e.toStatus ? TICKET_STATUS_LABEL[e.toStatus] : '?'}`;
  } else if (e.kind === 'ASSIGNED') {
    line = e.meta?.assigneeId ? 'assigned it' : 'unassigned it';
  } else if (e.kind === 'PRIORITY') {
    line = e.meta?.to ? `set priority to ${TICKET_PRIORITY_LABEL[e.meta.to as TicketPriority]}` : e.meta?.categoryTo ? `moved it to ${TICKET_CATEGORY_LABEL[e.meta.categoryTo as TicketCategory]}` : 'changed it';
  }
  return (
    <div className="tk-event ui-t-small ui-ink-3">
      <span className="ui-t-strong">{e.actor?.name ?? 'Timo'}</span> {line}{via} · {formatTicketTime(e.createdAt, tz)}
      {e.body && <p className="tk-body tk-event__note">{e.body}</p>}
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
  const ready = (body.trim().length > 0 || uploads.ids.length > 0) && !uploads.busy;
  return (
    <Card title={t.can.manage ? 'Reply' : 'Add a reply'}>
      <div className="tk-form">
        <Textarea
          rows={4}
          maxLength={5000}
          value={body}
          placeholder={internal ? 'Only admins see this note.' : t.can.manage ? `Reply to ${t.requester.name}. They get it on Lark.` : 'Add details or answer the admin.'}
          onChange={(e) => setBody(e.target.value)}
          onPaste={uploads.onPaste}
        />
        <TicketUploadPicker uploads={uploads} />
        {send.isError && <Banner status="danger">{errorText(send.error)}</Banner>}
        <Toolbar className="tk-composer__actions">
          {t.can.manage && (
            <label className="tk-check ui-t-small">
              <Checkbox checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note
            </label>
          )}
          {t.can.manage && !internal && t.status !== 'CLOSED' && (
            <Button variant="secondary" disabled={!ready} loading={send.isPending && send.variables?.askUser} onClick={() => send.mutate({ askUser: true })}>
              Ask {t.requester.name.split(' ')[0]}
            </Button>
          )}
          <Button variant="primary" disabled={!ready} loading={send.isPending && !send.variables?.askUser} onClick={() => send.mutate({ askUser: false })}>
            {internal ? 'Save note' : t.can.manage ? 'Reply' : 'Send'}
          </Button>
        </Toolbar>
      </div>
    </Card>
  );
}

function RequesterActions({ t, busy, onAct }: { t: TicketDetailDto; busy: boolean; onAct: (a: TicketActionRequest) => void }) {
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  return (
    <Toolbar>
      {t.can.confirm && (
        <>
          <Button variant="primary" loading={busy} onClick={() => onAct({ action: 'confirm' })}>Yes, it is fixed</Button>
          <Button variant="secondary" disabled={busy} onClick={() => onAct({ action: 'reopen', note: 'Still a problem' })}>Still a problem</Button>
        </>
      )}
      {!t.can.confirm && t.can.reopen && !t.can.manage && (
        <Button variant="secondary" loading={busy} onClick={() => onAct({ action: 'reopen' })}>Reopen</Button>
      )}
      {t.can.withdraw && (
        <Button variant="ghost" disabled={busy} onClick={() => setConfirmWithdraw(true)}>Withdraw</Button>
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
    </Toolbar>
  );
}

function DetailsCard({ t, tz, busy, onAct }: { t: TicketDetailDto; tz: string; busy: boolean; onAct: (a: TicketActionRequest) => void }) {
  const assigneesQ = useQuery({ ...ticketAssigneesQuery<{ assignees: TicketPersonDto[] }>(), enabled: t.can.manage });
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState('');
  const [dupOf, setDupOf] = useState('');
  const [dupOpen, setDupOpen] = useState(false);
  const active = t.status === 'OPEN' || t.status === 'IN_PROGRESS' || t.status === 'WAITING_ON_USER';

  return (
    <Card title="Details">
      <dl className="tk-facts">
        <dt>Requester</dt>
        <dd>{t.requester.name}<span className="ui-t-small ui-ink-3"> · {t.requester.email}</span></dd>
        <dt>Assignee</dt>
        <dd>
          {t.can.manage ? (
            <Select
              aria-label="Assignee"
              value={t.assignee?.id ?? ''}
              disabled={busy}
              onChange={(e) => onAct({ action: 'assign', assigneeId: e.target.value || null })}
            >
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
        <dt>Opened</dt>
        <dd>{formatTicketTime(t.createdAt, tz)}{t.source === 'LARK' ? ' · on Lark' : ''}</dd>
        {t.resolvedAt && (<><dt>Resolved</dt><dd>{formatTicketTime(t.resolvedAt, tz)}</dd></>)}
        {t.closedAt && (<><dt>Closed</dt><dd>{formatTicketTime(t.closedAt, tz)}</dd></>)}
      </dl>

      {t.can.manage && (
        <div className="tk-admin-actions">
          {active && !t.assignee && <Button variant="secondary" disabled={busy} onClick={() => onAct({ action: 'start' })}>Take it</Button>}
          {active && <Button variant="primary" disabled={busy} onClick={() => setResolving(true)}>Resolve</Button>}
          {t.status !== 'CLOSED' && <Button variant="secondary" disabled={busy} onClick={() => setDupOpen(true)}>Duplicate of…</Button>}
          {t.status !== 'CLOSED' && <Button variant="ghost" disabled={busy} onClick={() => onAct({ action: 'close' })}>Close</Button>}
          {!active && <Button variant="secondary" disabled={busy} onClick={() => onAct({ action: 'reopen' })}>Reopen</Button>}
        </div>
      )}

      <Modal
        open={resolving}
        onClose={() => setResolving(false)}
        title={`Resolve #${t.number}`}
        description={`${t.requester.name} is asked on Lark to confirm it is fixed. It closes by itself after 3 days without an answer.`}
        actions={
          <>
            <Button variant="secondary" onClick={() => setResolving(false)}>Cancel</Button>
            <Button variant="primary" onClick={() => { setResolving(false); onAct({ action: 'resolve', note: note.trim() || undefined }); setNote(''); }}>Resolve</Button>
          </>
        }
      >
        <Field label="What was done (they see this)">
          <Textarea rows={3} value={note} maxLength={5000} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Restored your Tuesday entry. Update Timo to beta.39." />
        </Field>
      </Modal>

      <Modal
        open={dupOpen}
        onClose={() => setDupOpen(false)}
        title={`Close #${t.number} as a duplicate`}
        description="The requester is told which ticket to follow."
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
          <Input value={dupOf} placeholder="#12" onChange={(e) => setDupOf(e.target.value)} />
        </Field>
      </Modal>
    </Card>
  );
}
