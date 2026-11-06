import { prisma } from '@grind/db';
import { TICKET_CATEGORIES, TICKET_SUBJECT_MAX, type TicketCategory } from '@grind/types';
import { logger } from '../logger';
import { buildDraftDoneCard, buildResolvedAnsweredCard, type TicketCardAction } from './cards';
import { guessCategory, suggestSubject } from './larkIntake';
import { adminCardFor, loadTicketForCard } from './outbox';
import {
  addTicketComment,
  applyTicketAction,
  createTicket,
  loadTicketActorByOpenId,
  TicketError,
  type TicketActor,
} from './service';

/**
 * Button clicks on ticket cards. Lark wants an answer within 3 seconds: a
 * toast and, usually, the card to show in place of the one clicked. Every
 * change is one short transaction in the service; the slower Lark fan-out
 * (other admins' cards, the requester's message) goes through the outbox.
 */

type CardActionEvent = {
  action?: { value?: unknown; form_value?: unknown };
  operator?: { open_id?: string };
};

type Reply = { toast: { type: 'success' | 'error' | 'info'; content: string }; card?: { type: 'raw'; data: Record<string, unknown> } };

const ERROR_TOASTS: Record<string, string> = {
  not_found: 'This ticket no longer exists.',
  forbidden: 'You cannot do that on this ticket.',
  invalid_transition: 'The ticket has moved on. Refreshed it.',
  reopen_window_passed: 'This ticket closed too long ago. Open a new one.',
  ticket_closed: 'This ticket is closed.',
  attachment_invalid: 'An attachment could not be added.',
  rate_limited: 'You have opened a lot of tickets today. Try again tomorrow, or reply on an open one.',
};

function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      return asRecord(JSON.parse(raw));
    } catch {
      return {};
    }
  }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function text(form: Record<string, unknown>, key: string): string {
  return typeof form[key] === 'string' ? (form[key] as string).trim() : '';
}

async function adminCard(ticketId: string): Promise<Reply['card']> {
  const state = await loadTicketForCard(ticketId);
  return state ? { type: 'raw', data: adminCardFor(state) } : undefined;
}

async function onAdminAction(actor: TicketActor, action: TicketCardAction, ticketId: string, note: string): Promise<Reply> {
  if (!actor.isAdmin) return { toast: { type: 'error', content: 'Only an admin can work tickets.' } };
  if (action === 'take') {
    await applyTicketAction({ ticketId, actor, action: { action: 'start' }, via: 'LARK' });
    return { toast: { type: 'success', content: 'It is yours.' }, card: await adminCard(ticketId) };
  }
  if (action === 'reply' || action === 'ask') {
    if (!note) return { toast: { type: 'error', content: 'Type the message first.' } };
    await addTicketComment({ ticketId, actor, body: note, askUser: action === 'ask', via: 'LARK' });
    return { toast: { type: 'success', content: action === 'ask' ? 'Asked. The ticket waits on them now.' : 'Reply sent.' }, card: await adminCard(ticketId) };
  }
  if (action === 'resolve') {
    const outcome = await applyTicketAction({ ticketId, actor, action: { action: 'resolve', note: note || undefined }, via: 'LARK' });
    return {
      toast: { type: outcome.changed ? 'success' : 'info', content: outcome.changed ? 'Resolved. They will be asked to confirm.' : 'Someone already resolved it.' },
      card: await adminCard(ticketId),
    };
  }
  // reopen
  const outcome = await applyTicketAction({ ticketId, actor, action: { action: 'reopen' }, via: 'LARK' });
  return { toast: { type: 'success', content: outcome.changed ? 'Reopened.' : 'Already open.' }, card: await adminCard(ticketId) };
}

async function onRequesterAction(actor: TicketActor, action: 'confirm' | 'still_problem', ticketId: string): Promise<Reply> {
  const ticket = await prisma.ticket.findUnique({ where: { id: ticketId }, select: { number: true, subject: true, requesterId: true } });
  if (!ticket) return { toast: { type: 'error', content: ERROR_TOASTS.not_found! } };
  if (ticket.requesterId !== actor.id) return { toast: { type: 'error', content: 'Only the person who opened it can answer this.' } };
  const outcome = await applyTicketAction({
    ticketId,
    actor,
    action: action === 'confirm' ? { action: 'confirm' } : { action: 'reopen', note: 'Still a problem' },
    via: 'LARK',
  });
  const fixed = action === 'confirm';
  return {
    toast: { type: 'success', content: fixed ? 'Closed. Thanks!' : outcome.changed ? 'Reopened. We will look again.' : 'It is already open.' },
    card: { type: 'raw', data: buildResolvedAnsweredCard({ ticketId, number: ticket.number, subject: ticket.subject, fixed }) },
  };
}

async function onDraftAction(actor: TicketActor, action: 'open_draft' | 'add_draft' | 'cancel_draft', draftId: string, form: Record<string, unknown>): Promise<Reply> {
  const draft = await prisma.ticketDraft.findUnique({
    where: { id: draftId },
    include: { _count: { select: { attachments: true } }, ticket: { select: { id: true, number: true } } },
  });
  if (!draft || draft.userId !== actor.id) return { toast: { type: 'error', content: 'This draft is not yours.' } };
  if (draft.status === 'USED' && draft.ticket) {
    return {
      toast: { type: 'info', content: `Already opened as #${draft.ticket.number}.` },
      card: { type: 'raw', data: buildDraftDoneCard({ title: `Ticket #${draft.ticket.number} opened`, body: 'An admin will reply here on Lark.', ticketId: draft.ticket.id, template: 'green' }) },
    };
  }
  if (draft.status !== 'OPEN') return { toast: { type: 'info', content: 'This draft was cancelled.' } };

  if (action === 'cancel_draft') {
    await prisma.ticketDraft.update({ where: { id: draft.id }, data: { status: 'CANCELLED' } });
    await prisma.ticketAttachment.deleteMany({ where: { draftId: draft.id, ticketId: null } });
    return { toast: { type: 'info', content: 'Cancelled.' }, card: { type: 'raw', data: buildDraftDoneCard({ title: 'No ticket opened', body: 'Cancelled. Send "ticket" and the problem any time.' }) } };
  }

  if (action === 'add_draft') {
    const ticketId = text(form, 'ticketId');
    if (!ticketId) return { toast: { type: 'error', content: 'Pick the ticket to add this to.' } };
    const attachmentIds = (await prisma.ticketAttachment.findMany({ where: { draftId: draft.id, ticketId: null }, select: { id: true } })).map((a) => a.id);
    const body = draft.text.trim() || (attachmentIds.length ? '(attachment)' : '');
    if (!body) return { toast: { type: 'error', content: 'Nothing to add yet. Send the message or screenshot first.' } };
    await addTicketComment({ ticketId, actor, body, attachmentIds, via: 'LARK' });
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticketId }, select: { number: true } });
    await prisma.ticketDraft.update({ where: { id: draft.id }, data: { status: 'USED', ticketId } });
    return {
      toast: { type: 'success', content: `Added to #${ticket.number}.` },
      card: { type: 'raw', data: buildDraftDoneCard({ title: `Added to #${ticket.number}`, body: 'An admin will see it.', ticketId, template: 'green' }) },
    };
  }

  // open_draft
  if (!draft.text.trim() && draft._count.attachments === 0) {
    return { toast: { type: 'error', content: 'Send a message saying what went wrong first.' } };
  }
  const subject = (text(form, 'subject') || suggestSubject(draft.text)).slice(0, TICKET_SUBJECT_MAX);
  const picked = text(form, 'category');
  const category: TicketCategory = (TICKET_CATEGORIES as readonly string[]).includes(picked) ? (picked as TicketCategory) : guessCategory(draft.text);
  const ticket = await createTicket({
    actor,
    subject: subject.length >= 3 ? subject : `${subject} (Lark)`,
    description: draft.text.trim() || 'See the attached screenshot.',
    category,
    via: 'LARK',
    draftId: draft.id,
    idempotencyKey: `lark-draft-${draft.id}`,
  });
  return {
    toast: { type: 'success', content: `Ticket #${ticket.number} opened.` },
    card: { type: 'raw', data: buildDraftDoneCard({ title: `Ticket #${ticket.number} opened`, body: 'An admin will reply here on Lark. Reply to Timo\'s messages about it to add more.', ticketId: ticket.id, template: 'green' }) },
  };
}

export async function handleTicketCardAction(raw: CardActionEvent, value: Record<string, unknown>): Promise<Reply> {
  const openId = raw.operator?.open_id;
  const action = typeof value.action === 'string' ? (value.action as TicketCardAction) : null;
  const ticketId = typeof value.ticketId === 'string' ? value.ticketId : null;
  const draftId = typeof value.draftId === 'string' ? value.draftId : null;
  if (!openId || !action) return { toast: { type: 'error', content: 'Bad payload' } };
  const actor = await loadTicketActorByOpenId(openId);
  if (!actor) return { toast: { type: 'error', content: 'Your Timo account is not active.' } };
  const form = asRecord(raw.action?.form_value);
  try {
    if ((action === 'open_draft' || action === 'add_draft' || action === 'cancel_draft') && draftId) {
      return await onDraftAction(actor, action, draftId, form);
    }
    if (!ticketId) return { toast: { type: 'error', content: 'Bad payload' } };
    if (action === 'confirm' || action === 'still_problem') return await onRequesterAction(actor, action, ticketId);
    return await onAdminAction(actor, action, ticketId, text(form, 'note'));
  } catch (err) {
    if (err instanceof TicketError) {
      logger.info({ ticketId, draftId, action, code: err.code }, 'ticket card action refused');
      const card = ticketId && actor.isAdmin ? await adminCard(ticketId).catch(() => undefined) : undefined;
      return { toast: { type: 'error', content: ERROR_TOASTS[err.code] ?? 'Could not do that.' }, ...(card ? { card } : {}) };
    }
    throw err;
  }
}

