import {
  TICKET_CATEGORIES,
  TICKET_CATEGORY_LABEL,
  TICKET_CLOSE_REASON_LABEL,
  TICKET_PRIORITY_LABEL,
  TICKET_STATUS_LABEL,
  type TicketCategory,
  type TicketCloseReason,
  type TicketPriority,
  type TicketStatus,
} from '@grind/types';
import { env, parseUrlList } from '../env';

/**
 * Lark Interactive Card (schema 2.0) builders for support tickets. Pure — no I/O.
 *
 * Button values carry `{ kind: 'ticket', action, ticketId | draftId }`; the
 * card callback routes on `kind`. Admin cards hold a form (one note box and
 * Reply / Ask / Resolve) so an admin can work a ticket without the dashboard.
 */

export const TICKET_CARD_KIND = 'ticket';
export type TicketCardAction =
  | 'take'
  | 'reply'
  | 'ask'
  | 'resolve'
  | 'reopen'
  | 'confirm'
  | 'still_problem'
  | 'open_draft'
  | 'add_draft'
  | 'cancel_draft';

export function dashboardBaseUrl(): string {
  return (env.PUBLIC_APP_URL ?? parseUrlList(env.DASHBOARD_URL)[0] ?? 'https://timo.emiactech.com').replace(/\/$/u, '');
}

export function ticketUrl(ticketId: string): string {
  return `${dashboardBaseUrl()}/tickets/${ticketId}`;
}

/** Lark markdown treats these as syntax; what people typed is plain text. */
export function plain(text: string): string {
  return text.replace(/([*_~`[\]<>#])/gu, '\\$1');
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function fmt(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
}

const STATUS_TEMPLATE: Record<TicketStatus, string> = {
  OPEN: 'red',
  IN_PROGRESS: 'blue',
  WAITING_ON_USER: 'yellow',
  RESOLVED: 'green',
  CLOSED: 'grey',
};

function value(action: TicketCardAction, ids: { ticketId?: string; draftId?: string }): Record<string, unknown> {
  return { kind: TICKET_CARD_KIND, action, ...ids };
}

function linkButton(text: string, url: string): Record<string, unknown> {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type: 'default',
    behaviors: [{ type: 'open_url', default_url: url }],
  };
}

function card(title: string, template: string, elements: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: clip(title, 100) }, template },
    body: { elements },
  };
}

function md(content: string): Record<string, unknown> {
  return { tag: 'markdown', content };
}

export interface AdminTicketCardInput {
  ticketId: string;
  number: number;
  subject: string;
  description: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  closeReason: TicketCloseReason | null;
  requesterName: string;
  requesterTeam: string | null;
  requesterUnit: string | null;
  requesterVersion: string | null;
  requesterUnreachable: boolean;
  createdByName: string | null;
  assigneeName: string | null;
  attachmentCount: number;
  createdAt: number;
  timeZone: string;
  latest: { who: string; body: string; at: number } | null;
}

/** The card every ticket admin gets, kept current in place and pinned while the ticket is open. */
export function buildAdminTicketCard(t: AdminTicketCardInput): Record<string, unknown> {
  const who = [plain(t.requesterName), t.requesterTeam && plain(t.requesterTeam), t.requesterUnit].filter(Boolean).join(' · ');
  const facts = [
    TICKET_CATEGORY_LABEL[t.category],
    t.priority === 'NORMAL' ? null : `**${TICKET_PRIORITY_LABEL[t.priority]}**`,
    `Status: **${TICKET_STATUS_LABEL[t.status]}**`,
    t.assigneeName ? `With: ${plain(t.assigneeName)}` : 'Unassigned',
  ].filter(Boolean).join(' · ');
  const opened = `Opened ${fmt(t.createdAt, t.timeZone)}${t.createdByName ? ` by ${plain(t.createdByName)} for them` : ''}`
    + (t.requesterVersion ? ` · Timo ${plain(t.requesterVersion)}` : '');
  const elements: Array<Record<string, unknown>> = [
    md(`**${who}**\n${facts}\n${opened}`),
    md(plain(clip(t.description, 1500))),
  ];
  if (t.attachmentCount > 0) elements.push(md(`📎 ${t.attachmentCount} attachment${t.attachmentCount === 1 ? '' : 's'}, open in Timo to see them`));
  if (t.latest) elements.push(md(`**Latest, ${plain(t.latest.who)}** · ${fmt(t.latest.at, t.timeZone)}\n${plain(clip(t.latest.body, 600))}`));
  if (t.requesterUnreachable) elements.push(md('⚠️ Timo cannot message this person on Lark. Reply from the dashboard.'));
  elements.push({ tag: 'hr' });

  const ids = { ticketId: t.ticketId };
  if (t.status === 'OPEN' || t.status === 'IN_PROGRESS' || t.status === 'WAITING_ON_USER') {
    elements.push({
      tag: 'form',
      name: 'ticket_form',
      elements: [
        {
          tag: 'input',
          name: 'note',
          placeholder: { tag: 'plain_text', content: 'Reply, question, or how it was fixed' },
          input_type: 'multiline_text',
          rows: 2,
          width: 'fill',
          max_length: 2000,
        },
        {
          tag: 'column_set',
          flex_mode: 'flow',
          columns: [
            { tag: 'column', width: 'auto', elements: [formButton('Reply', 'default', value('reply', ids))] },
            { tag: 'column', width: 'auto', elements: [formButton('Ask requester', 'default', value('ask', ids))] },
            { tag: 'column', width: 'auto', elements: [formButton('Resolve', 'primary_filled', value('resolve', ids))] },
          ],
        },
      ],
    });
    const row: Array<Record<string, unknown>> = [];
    if (!t.assigneeName) {
      row.push({ tag: 'column', width: 'auto', elements: [{
        tag: 'button',
        text: { tag: 'plain_text', content: 'Take it' },
        type: 'primary',
        behaviors: [{ type: 'callback', value: value('take', ids) }],
      }] });
    }
    row.push({ tag: 'column', width: 'auto', elements: [linkButton('Open in Timo', ticketUrl(t.ticketId))] });
    elements.push({ tag: 'column_set', flex_mode: 'flow', columns: row });
  } else {
    const line = t.status === 'RESOLVED'
      ? 'Resolved. Waiting for the requester to confirm it is fixed.'
      : `Closed${t.closeReason ? `: ${TICKET_CLOSE_REASON_LABEL[t.closeReason]}` : ''}.`;
    elements.push(md(line));
    elements.push({
      tag: 'column_set',
      flex_mode: 'flow',
      columns: [
        { tag: 'column', width: 'auto', elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: 'Reopen' },
          type: 'default',
          behaviors: [{ type: 'callback', value: value('reopen', ids) }],
        }] },
        { tag: 'column', width: 'auto', elements: [linkButton('Open in Timo', ticketUrl(t.ticketId))] },
      ],
    });
  }
  return card(`#${t.number} · ${t.subject}`, STATUS_TEMPLATE[t.status], elements);
}

function formButton(text: string, type: string, v: Record<string, unknown>): Record<string, unknown> {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    form_action_type: 'submit',
    behaviors: [{ type: 'callback', value: v }],
  };
}

export interface UserNoticeInput {
  ticketId: string;
  number: number;
  subject: string;
  title: string;
  body: string | null;
  template?: string;
  /** Show the reply hint. */
  canReply?: boolean;
}

/** A message to the requester: created, a reply, a question, closed, a reminder. */
export function buildUserNoticeCard(n: UserNoticeInput): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [md(`**#${n.number} · ${plain(clip(n.subject, 120))}**`)];
  if (n.body) elements.push(md(plain(clip(n.body, 2500))));
  if (n.canReply) elements.push(md('_Reply to this message to answer, or open the ticket in Timo._'));
  elements.push(linkButton('Open in Timo', ticketUrl(n.ticketId)));
  return card(n.title, n.template ?? 'blue', elements);
}

/** After a resolve: did it work? */
export function buildResolvedCard(n: { ticketId: string; number: number; subject: string; resolvedBy: string | null; note: string | null; reminder?: boolean }): Record<string, unknown> {
  const ids = { ticketId: n.ticketId };
  const elements: Array<Record<string, unknown>> = [
    md(`**#${n.number} · ${plain(clip(n.subject, 120))}**${n.resolvedBy ? `\nResolved by ${plain(n.resolvedBy)}` : ''}`),
  ];
  if (n.note) elements.push(md(plain(clip(n.note, 2000))));
  elements.push(md(n.reminder ? 'Is it fixed? If we do not hear back, the ticket closes in a couple of days.' : 'Is it fixed?'));
  elements.push({
    tag: 'column_set',
    flex_mode: 'flow',
    columns: [
      { tag: 'column', width: 'auto', elements: [{
        tag: 'button', text: { tag: 'plain_text', content: 'Yes, it is fixed' }, type: 'primary_filled',
        behaviors: [{ type: 'callback', value: value('confirm', ids) }],
      }] },
      { tag: 'column', width: 'auto', elements: [{
        tag: 'button', text: { tag: 'plain_text', content: 'Still a problem' }, type: 'default',
        behaviors: [{ type: 'callback', value: value('still_problem', ids) }],
      }] },
      { tag: 'column', width: 'auto', elements: [linkButton('Open in Timo', ticketUrl(n.ticketId))] },
    ],
  });
  return card(n.reminder ? `Reminder: is #${n.number} fixed?` : `#${n.number} resolved`, 'green', elements);
}

/** What a resolved card turns into once the requester answers. */
export function buildResolvedAnsweredCard(n: { ticketId: string; number: number; subject: string; fixed: boolean }): Record<string, unknown> {
  return buildUserNoticeCard({
    ticketId: n.ticketId,
    number: n.number,
    subject: n.subject,
    title: n.fixed ? `#${n.number} closed. Thanks!` : `#${n.number} reopened`,
    body: n.fixed ? 'Glad it is sorted.' : 'We will look at it again. Reply to this message to add what is still wrong.',
    template: n.fixed ? 'grey' : 'orange',
    canReply: !n.fixed,
  });
}

/** A short notice to an admin: the requester replied, a ticket was assigned to them, a reminder. */
export function buildAdminNoticeCard(n: { ticketId: string; number: number; subject: string; title: string; body: string | null; template?: string }): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [md(`**#${n.number} · ${plain(clip(n.subject, 120))}**`)];
  if (n.body) elements.push(md(plain(clip(n.body, 1500))));
  elements.push(linkButton('Open in Timo', ticketUrl(n.ticketId)));
  return card(n.title, n.template ?? 'orange', elements);
}

export interface DraftCardInput {
  draftId: string;
  text: string;
  attachmentCount: number;
  suggestedSubject: string;
  suggestedCategory: TicketCategory;
  openTickets: Array<{ id: string; number: number; subject: string }>;
}

/** "Open a ticket?" — the confirm card for something sent to the bot in DM. */
export function buildDraftCard(d: DraftCardInput): Record<string, unknown> {
  const ids = { draftId: d.draftId };
  const preview = d.text.trim()
    ? plain(clip(d.text, 1200))
    : '_No description yet. Send a message saying what went wrong, then press Open ticket._';
  const elements: Array<Record<string, unknown>> = [md(preview)];
  if (d.attachmentCount > 0) elements.push(md(`📎 ${d.attachmentCount} attachment${d.attachmentCount === 1 ? '' : 's'}`));
  elements.push(md('_Send more messages or screenshots now and they are added here._'));
  const formElements: Array<Record<string, unknown>> = [
    {
      tag: 'input',
      name: 'subject',
      placeholder: { tag: 'plain_text', content: 'Short title' },
      default_value: clip(d.suggestedSubject, 120),
      width: 'fill',
      max_length: 120,
    },
    {
      tag: 'select_static',
      name: 'category',
      placeholder: { tag: 'plain_text', content: 'Category' },
      width: 'fill',
      initial_option: d.suggestedCategory,
      options: TICKET_CATEGORIES.map((c) => ({ text: { tag: 'plain_text', content: TICKET_CATEGORY_LABEL[c] }, value: c })),
    },
  ];
  const buttons: Array<Record<string, unknown>> = [
    { tag: 'column', width: 'auto', elements: [formButton('Open ticket', 'primary_filled', value('open_draft', ids))] },
  ];
  if (d.openTickets.length > 0) {
    formElements.push({
      tag: 'select_static',
      name: 'ticketId',
      placeholder: { tag: 'plain_text', content: 'Or add to an open ticket' },
      width: 'fill',
      options: d.openTickets.slice(0, 10).map((t) => ({ text: { tag: 'plain_text', content: clip(`#${t.number} ${t.subject}`, 60) }, value: t.id })),
    });
    buttons.push({ tag: 'column', width: 'auto', elements: [formButton('Add to that ticket', 'default', value('add_draft', ids))] });
  }
  buttons.push({ tag: 'column', width: 'auto', elements: [formButton('Cancel', 'default', value('cancel_draft', ids))] });
  formElements.push({ tag: 'column_set', flex_mode: 'flow', columns: buttons });
  elements.push({ tag: 'form', name: 'draft_form', elements: formElements });
  return card('Open a support ticket?', 'blue', elements);
}

export function buildDraftDoneCard(n: { title: string; body: string; ticketId?: string; template?: string }): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [md(n.body)];
  if (n.ticketId) elements.push(linkButton('Open in Timo', ticketUrl(n.ticketId)));
  return card(n.title, n.template ?? 'grey', elements);
}

export interface DigestInput {
  date: string;
  open: number;
  unassigned: number;
  waitingOnUser: number;
  resolved: number;
  oldest: Array<{ id: string; number: number; subject: string; requester: string; ageDays: number; status: TicketStatus }>;
}

/** The 10:00 digest for each ticket admin. */
export function buildDigestCard(d: DigestInput): Record<string, unknown> {
  const counts = [
    `**${d.open}** need an admin`,
    `**${d.unassigned}** unassigned`,
    `**${d.waitingOnUser}** waiting on requester`,
    `**${d.resolved}** awaiting confirmation`,
  ].join(' · ');
  const rows = d.oldest.map((t) => `[#${t.number}](${ticketUrl(t.id)}) ${plain(clip(t.subject, 60))} · ${plain(t.requester)} · ${t.ageDays}d · ${TICKET_STATUS_LABEL[t.status]}`);
  return card(`Support tickets · ${d.date}`, 'blue', [
    md(counts),
    ...(rows.length ? [md(rows.join('\n'))] : []),
    linkButton('Open tickets in Timo', `${dashboardBaseUrl()}/tickets?scope=all`),
  ]);
}
