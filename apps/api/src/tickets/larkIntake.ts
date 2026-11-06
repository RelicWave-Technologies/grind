import { prisma } from '@grind/db';
import {
  TICKET_ATTACHMENT_MAX_BYTES,
  TICKET_ATTACHMENT_MIME_TYPES,
  TICKET_BODY_MAX,
  TICKET_CATEGORIES,
  TICKET_REOPEN_WINDOW_DAYS,
  TICKET_SUBJECT_MAX,
  type TicketCategory,
} from '@grind/types';
import { getLarkMessenger } from '../lark';
import { logger } from '../logger';
import { enqueueSupportDm, supportAgentAvailable, type SupportHooks } from '../support/agent';
import { getTicketAi, intakeHash, ruleIntake, todayLabel, type OpenTicketRef, type TicketIntake } from './ai';
import { buildDraftCard } from './cards';
import { downloadLarkMessageResource } from './larkApi';
import { addTicketComment, applyTicketAction, loadTicketActorByOpenId, TicketError, type TicketActor } from './service';

/**
 * Tickets from a Lark DM with the Timo bot.
 *
 * - "ticket <what is wrong>" starts a draft and the bot answers with a confirm
 *   card (title, category, [Open ticket]). Anything else sent while a draft is
 *   open — more text, screenshots — is added to it.
 * - A quote-reply to any message Timo sent about a ticket lands on that ticket
 *   as a comment (with any image), from the requester or an admin.
 * - A message the intake does not claim falls through to the tester-ops bot,
 *   which offers a ticket when it reads a problem report.
 *
 * Returns true when the message was handled here.
 */

const DRAFT_TTL_MS = 2 * 60 * 60 * 1000;
const TICKET_KEYWORD = /^\s*[/#]?(ticket|support|help ?desk)\b[\s:,-]*/iu;

type ParsedDm = {
  messageId: string;
  chatId: string | null;
  openId: string;
  messageType: string;
  text: string;
  /** Images / files in the message, by Lark resource key. */
  resources: Array<{ key: string; type: 'image' | 'file'; name: string | null }>;
  parentId: string | null;
  rootId: string | null;
};

export function parseLarkDm(raw: unknown): ParsedDm | null {
  if (!raw || typeof raw !== 'object') return null;
  const root = raw as Record<string, unknown>;
  const event = root.event && typeof root.event === 'object' ? (root.event as Record<string, unknown>) : root;
  const message = event.message && typeof event.message === 'object' ? (event.message as Record<string, unknown>) : null;
  if (!message || message.chat_type !== 'p2p') return null;
  const sender = event.sender && typeof event.sender === 'object' ? (event.sender as Record<string, unknown>) : null;
  if (sender?.sender_type && sender.sender_type !== 'user') return null;
  const senderId = sender?.sender_id && typeof sender.sender_id === 'object' ? (sender.sender_id as Record<string, unknown>) : null;
  const openId = typeof senderId?.open_id === 'string' ? senderId.open_id : null;
  const messageId = typeof message.message_id === 'string' ? message.message_id : null;
  if (!openId || !messageId) return null;
  const messageType = typeof message.message_type === 'string' ? message.message_type : 'text';
  let content: Record<string, unknown> = {};
  try {
    content = JSON.parse(typeof message.content === 'string' ? message.content : '{}') as Record<string, unknown>;
  } catch {
    content = {};
  }
  const resources: ParsedDm['resources'] = [];
  let text = '';
  if (messageType === 'text') {
    text = typeof content.text === 'string' ? content.text : '';
  } else if (messageType === 'image' && typeof content.image_key === 'string') {
    resources.push({ key: content.image_key, type: 'image', name: null });
  } else if (messageType === 'file' && typeof content.file_key === 'string') {
    resources.push({ key: content.file_key, type: 'file', name: typeof content.file_name === 'string' ? content.file_name : null });
  } else if (messageType === 'post') {
    // A rich post: { title, content: [[{tag:'text',text}|{tag:'img',image_key}]] }, possibly per locale.
    const body = (content.content ? content : Object.values(content).find((v) => v && typeof v === 'object')) as
      | { title?: string; content?: unknown }
      | undefined;
    const parts: string[] = body?.title ? [body.title] : [];
    for (const line of Array.isArray(body?.content) ? body!.content as unknown[] : []) {
      const words: string[] = [];
      for (const el of Array.isArray(line) ? line : []) {
        const e = el as Record<string, unknown>;
        if (e.tag === 'text' || e.tag === 'a') words.push(String(e.text ?? ''));
        if (e.tag === 'img' && typeof e.image_key === 'string') resources.push({ key: e.image_key, type: 'image', name: null });
      }
      parts.push(words.join(''));
    }
    text = parts.join('\n');
  }
  return {
    messageId,
    chatId: typeof message.chat_id === 'string' ? message.chat_id : null,
    openId,
    messageType,
    text: text.replace(/@_user_\d+/gu, '').trim(),
    resources,
    parentId: typeof message.parent_id === 'string' && message.parent_id ? message.parent_id : null,
    rootId: typeof message.root_id === 'string' && message.root_id ? message.root_id : null,
  };
}

export { guessCategory, suggestSubject } from './ai';

async function claimMessage(messageId: string): Promise<boolean> {
  const inserted = await prisma.ticketInboundMessage.createMany({ data: [{ messageId }], skipDuplicates: true });
  return inserted.count === 1;
}

async function reply(openId: string, card: Record<string, unknown>): Promise<string | null> {
  const messenger = getLarkMessenger();
  if (!messenger) return null;
  try {
    return (await messenger.sendCard(openId, card)).messageId;
  } catch (err) {
    logger.warn({ err: String(err) }, 'ticket intake reply failed');
    return null;
  }
}

async function replyText(openId: string, text: string): Promise<void> {
  const messenger = getLarkMessenger();
  if (!messenger) return;
  await messenger.sendText(openId, text).catch((err) => logger.warn({ err: String(err) }, 'ticket intake text failed'));
}

/** Download what was sent and keep it as an unbound attachment of `uploaderId`. */
async function storeResources(dm: ParsedDm, uploaderId: string, target: { draftId?: string }): Promise<string[]> {
  const ids: string[] = [];
  for (const r of dm.resources.slice(0, 5)) {
    try {
      const { data, mimeType } = await downloadLarkMessageResource({
        messageId: dm.messageId,
        fileKey: r.key,
        type: r.type,
        maxBytes: TICKET_ATTACHMENT_MAX_BYTES,
      });
      const mime = (TICKET_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mimeType) ? mimeType : r.type === 'image' ? 'image/png' : null;
      if (!mime) {
        await replyText(dm.openId, `Skipped ${r.name ?? 'a file'}: only images, PDF and text files can be attached.`);
        continue;
      }
      const ext = mime.split('/')[1] === 'jpeg' ? 'jpg' : mime.split('/')[1];
      const row = await prisma.ticketAttachment.create({
        data: {
          uploaderId,
          fileName: r.name ?? `lark-${r.type}-${Date.now()}.${ext}`,
          mimeType: mime,
          sizeBytes: data.byteLength,
          data,
          draftId: target.draftId ?? null,
        },
        select: { id: true },
      });
      ids.push(row.id);
    } catch (err) {
      const tooLarge = String(err).includes('too_large');
      logger.warn({ err: String(err), messageId: dm.messageId }, 'ticket intake resource download failed');
      await replyText(dm.openId, tooLarge ? 'That file is over 5 MB, so it was not attached.' : 'I could not read that attachment. Try sending it again.');
    }
  }
  return ids;
}

async function openTicketsOf(userId: string): Promise<OpenTicketRef[]> {
  return prisma.ticket.findMany({
    where: { requesterId: userId, status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_ON_USER', 'RESOLVED'] } },
    orderBy: { updatedAt: 'desc' },
    take: 10,
    select: { id: true, number: true, subject: true, category: true },
  });
}

/** Ask the AI what a piece of text is about, with the person's open tickets and today's date. */
async function readIntake(actor: TicketActor, text: string, openTickets?: OpenTicketRef[]): Promise<TicketIntake> {
  const open = openTickets ?? (await openTicketsOf(actor.id));
  const ws = await prisma.workspace.findUnique({ where: { id: actor.workspaceId }, select: { timezone: true } });
  try {
    return await getTicketAi().analyze({ workspaceId: actor.workspaceId, text, openTickets: open, today: todayLabel(ws?.timezone ?? 'Asia/Kolkata') });
  } catch (err) {
    logger.warn({ err: String(err) }, 'ticket ai threw; using rules');
    return ruleIntake(text);
  }
}

/**
 * Bring the draft's AI reading up to date with its text. Skipped when the text
 * (and the open tickets it was read against) has not changed since last time.
 * `known` is a reading already made of exactly this text.
 */
async function refreshDraftIntake(draftId: string, actor: TicketActor, known?: TicketIntake): Promise<void> {
  const draft = await prisma.ticketDraft.findUnique({ where: { id: draftId }, select: { text: true, aiTextHash: true } });
  if (!draft) return;
  const open = await openTicketsOf(actor.id);
  const hash = intakeHash(draft.text, open);
  if (draft.aiTextHash === hash) return;
  if (!draft.text.trim()) {
    await prisma.ticketDraft.update({
      where: { id: draftId },
      data: { aiSubject: null, aiCategory: null, aiRelatedTicketId: null, aiQuestion: null, aiTextHash: hash },
    });
    return;
  }
  const r = known ?? (await readIntake(actor, draft.text, open));
  await prisma.ticketDraft.update({
    where: { id: draftId },
    data: {
      aiSubject: r.fromAi ? r.subject : null,
      aiCategory: r.fromAi ? r.category : null,
      aiRelatedTicketId: r.relatedTicketId,
      aiQuestion: r.question,
      // A rules-only reading is not cached: the model may answer next time.
      aiTextHash: r.fromAi ? hash : null,
    },
  });
}

export async function draftCardFor(draftId: string, hint?: string): Promise<Record<string, unknown> | null> {
  const draft = await prisma.ticketDraft.findUnique({
    where: { id: draftId },
    include: { _count: { select: { attachments: true } } },
  });
  if (!draft) return null;
  const openTickets = await openTicketsOf(draft.userId);
  const rules = ruleIntake(draft.text);
  return buildDraftCard({
    draftId: draft.id,
    text: draft.text,
    attachmentCount: draft._count.attachments,
    suggestedSubject: draft.aiSubject ?? rules.subject,
    suggestedCategory: draft.aiCategory ?? rules.category,
    openTickets,
    // Only while that ticket is still open; it may have closed since.
    related: openTickets.find((t) => t.id === draft.aiRelatedTicketId) ?? null,
    question: draft.aiQuestion,
    hint,
  });
}

/** Send (or refresh) the confirm card for a draft. */
async function showDraft(draftId: string, openId: string, hint?: string): Promise<void> {
  const card = await draftCardFor(draftId, hint);
  if (!card) return;
  const draft = await prisma.ticketDraft.findUniqueOrThrow({ where: { id: draftId }, select: { offerMessageId: true } });
  const messenger = getLarkMessenger();
  if (draft.offerMessageId && messenger) {
    try {
      await messenger.updateCard(draft.offerMessageId, card);
      return;
    } catch {
      // Fall through and send a fresh one.
    }
  }
  const messageId = await reply(openId, card);
  if (messageId) await prisma.ticketDraft.update({ where: { id: draftId }, data: { offerMessageId: messageId } });
}

async function openDraftOf(userId: string) {
  return prisma.ticketDraft.findFirst({
    where: { userId, status: 'OPEN', updatedAt: { gte: new Date(Date.now() - DRAFT_TTL_MS) } },
    orderBy: { updatedAt: 'desc' },
  });
}

async function startOrExtendDraft(actor: TicketActor, dm: ParsedDm, text: string, known?: TicketIntake): Promise<void> {
  const draft = (await openDraftOf(actor.id)) ?? (await prisma.ticketDraft.create({
    data: { workspaceId: actor.workspaceId, userId: actor.id, text: '' },
  }));
  const joined = [draft.text, text].filter((t) => t.trim()).join('\n').slice(0, TICKET_BODY_MAX);
  if (joined !== draft.text) await prisma.ticketDraft.update({ where: { id: draft.id }, data: { text: joined } });
  else await prisma.ticketDraft.update({ where: { id: draft.id }, data: { updatedAt: new Date() } });
  await storeResources(dm, actor.id, { draftId: draft.id });
  // `known` was read from this message alone; it is the draft's reading only when the draft is just this message.
  await refreshDraftIntake(draft.id, actor, joined === text ? known : undefined);
  await showDraft(draft.id, dm.openId);
}

/** A quote-reply to a ticket message: add it to that ticket. */
async function replyToTicket(actor: TicketActor, dm: ParsedDm, ticketId: string): Promise<void> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: { id: true, number: true, subject: true, requesterId: true, status: true, closedAt: true, closeReason: true },
  });
  if (!ticket) return;
  const isRequester = ticket.requesterId === actor.id;
  if (!isRequester && !actor.isAdmin) return;
  const attachmentIds = await storeResources(dm, actor.id, {});
  const body = dm.text || (attachmentIds.length ? '(attachment)' : '');
  if (!body) return;
  try {
    if (isRequester && ticket.status === 'CLOSED') {
      const withinWindow = ticket.closedAt && Date.now() - ticket.closedAt.getTime() <= TICKET_REOPEN_WINDOW_DAYS * 86_400_000;
      if (!withinWindow || ticket.closeReason === 'DUPLICATE') {
        await replyText(dm.openId, `#${ticket.number} is closed. Send "ticket" followed by the problem to open a new one.`);
        return;
      }
      await applyTicketAction({ ticketId, actor, action: { action: 'reopen' }, via: 'LARK' });
    }
    await addTicketComment({
      ticketId,
      actor,
      body,
      attachmentIds,
      via: 'LARK',
      meta: { larkMessageId: dm.messageId },
    });
    await replyText(dm.openId, `Added to #${ticket.number}.`);
  } catch (err) {
    if (err instanceof TicketError) {
      await replyText(dm.openId, `Could not add that to #${ticket.number} (${err.code}).`);
      return;
    }
    throw err;
  }
}

/**
 * Handle a 1:1 DM to the bot, if it is about tickets. `fallback` says whether
 * anything else (the tester-ops bot) will answer an unclaimed message; when it
 * will not, any message from a known person starts a ticket draft.
 */
export async function handleTicketDm(raw: unknown, opts: { fallback: boolean }): Promise<boolean> {
  const dm = parseLarkDm(raw);
  if (!dm) return false;
  const actor = await loadTicketActorByOpenId(dm.openId);
  if (!actor) return false; // unknown or not yet let in: the access flow / tester bot handles them

  const quoted = dm.parentId ?? dm.rootId;
  const ticketMessage = quoted
    ? await prisma.ticketLarkMessage.findUnique({ where: { messageId: quoted }, select: { ticketId: true } })
    : null;
  // Everything else from a known person goes to the support agent when it is on.
  if (!ticketMessage && supportAgentAvailable()) {
    if (!(await claimMessage(dm.messageId))) return true;
    void enqueueSupportDm(
      actor,
      { messageId: dm.messageId, openId: dm.openId, text: dm.text, hasResources: dm.resources.length > 0, raw },
      supportHooks,
    ).catch((err) => logger.error({ err: String(err) }, 'support agent queue failed'));
    return true;
  }

  const keyword = TICKET_KEYWORD.exec(dm.text);
  const draft = ticketMessage || keyword ? null : await openDraftOf(actor.id);
  const claims = Boolean(ticketMessage || keyword || draft || dm.resources.length > 0 || !opts.fallback);
  if (!claims) return false;
  if (!(await claimMessage(dm.messageId))) return true; // a redelivery we already handled

  try {
    if (ticketMessage) {
      await replyToTicket(actor, dm, ticketMessage.ticketId);
    } else if (keyword) {
      const rest = dm.text.slice(keyword[0].length).trim();
      if (!rest && dm.resources.length === 0) {
        await startOrExtendDraft(actor, dm, '');
      } else {
        await startOrExtendDraft(actor, dm, rest);
      }
    } else if (draft || dm.resources.length > 0) {
      await startOrExtendDraft(actor, dm, dm.text);
    } else {
      // Nobody else will answer this (the tester bot is off): let the AI tell a
      // problem from a "hi" or a "thanks", so small talk does not open drafts.
      const reading = await readIntake(actor, dm.text);
      if (reading.fromAi && reading.kind === 'CHITCHAT') {
        await replyText(dm.openId, 'Hi! If something is wrong in Timo, tell me what happened (a screenshot helps) and I will open a ticket for the admins.');
      } else {
        await startOrExtendDraft(actor, dm, dm.text, reading);
      }
    }
  } catch (err) {
    logger.error({ err: String(err), messageId: dm.messageId }, 'ticket DM intake failed');
    await replyText(dm.openId, 'Something went wrong while saving that. Please try again, or open a ticket in Timo.');
  }
  return true;
}

// ---------------------------------------------------------------------------
// The support agent's side of the intake
// ---------------------------------------------------------------------------

const AGENT_DRAFT_HINT = '_Anything to add? Tell me here and I will update this card before you press Open ticket._';

/**
 * The agent asked for a ticket: put its title, category and summary on the
 * person's draft (a new one, or the open one, replaced) with the screenshots
 * from the chat, and show the card. Filing stays the person's press.
 */
export async function offerAgentDraft(
  actor: TicketActor,
  openId: string,
  offer: { subject: string; category: string; body: string; relatedTicketNumber: number | null; attachmentIds: string[] },
): Promise<void> {
  const open = await openTicketsOf(actor.id);
  const related = offer.relatedTicketNumber == null ? null : open.find((t) => t.number === offer.relatedTicketNumber) ?? null;
  const category = (TICKET_CATEGORIES as readonly string[]).includes(offer.category) ? (offer.category as TicketCategory) : 'OTHER';
  const text = offer.body.slice(0, TICKET_BODY_MAX);
  const subject = offer.subject.replace(/\s+/gu, ' ').trim();
  const data = {
    text,
    aiSubject: subject.length > TICKET_SUBJECT_MAX ? `${subject.slice(0, TICKET_SUBJECT_MAX - 1).trimEnd()}…` : subject,
    aiCategory: category,
    aiRelatedTicketId: related?.id ?? null,
    aiQuestion: null,
    // Marks this text as already read, so the draft is not re-read by the intake model.
    aiTextHash: intakeHash(text, open),
  };
  const existing = await openDraftOf(actor.id);
  const draft = existing
    ? await prisma.ticketDraft.update({ where: { id: existing.id }, data })
    : await prisma.ticketDraft.create({ data: { workspaceId: actor.workspaceId, userId: actor.id, ...data } });
  if (offer.attachmentIds.length) {
    // Only this person's own uploads that no ticket or other draft holds yet.
    await prisma.ticketAttachment.updateMany({
      where: { id: { in: offer.attachmentIds.slice(-5) }, uploaderId: actor.id, ticketId: null, OR: [{ draftId: null }, { draftId: draft.id }] },
      data: { draftId: draft.id },
    });
  }
  await showDraft(draft.id, openId, AGENT_DRAFT_HINT);
}

/** The agent could not answer: the plain intake takes over, with what was already downloaded. */
export async function fallbackFromAgent(actor: TicketActor, openId: string, text: string, attachmentIds: string[]): Promise<void> {
  const trimmed = text.trim();
  if (trimmed && attachmentIds.length === 0) {
    const reading = await readIntake(actor, trimmed);
    if (reading.fromAi && reading.kind === 'CHITCHAT') {
      await replyText(openId, 'Hi! If something is wrong in Timo, tell me what happened (a screenshot helps) and I will get it to the admins.');
      return;
    }
  }
  await replyText(openId, 'I could not look into this right now, so here is a ticket for the admins. Check it and press Open ticket.');
  const draft = (await openDraftOf(actor.id)) ?? (await prisma.ticketDraft.create({ data: { workspaceId: actor.workspaceId, userId: actor.id, text: '' } }));
  const joined = [draft.text, trimmed].filter((t) => t.trim()).join('\n').slice(0, TICKET_BODY_MAX);
  if (joined !== draft.text) await prisma.ticketDraft.update({ where: { id: draft.id }, data: { text: joined } });
  if (attachmentIds.length) {
    await prisma.ticketAttachment.updateMany({
      where: { id: { in: attachmentIds }, uploaderId: actor.id, ticketId: null, draftId: null },
      data: { draftId: draft.id },
    });
  }
  await refreshDraftIntake(draft.id, actor);
  await showDraft(draft.id, openId);
}

const supportHooks: SupportHooks = {
  async storeAttachments(_dm, raw, uploaderId) {
    const parsed = parseLarkDm(raw);
    return parsed ? storeResources(parsed, uploaderId, {}) : [];
  },
  offerDraft: offerAgentDraft,
  fallback: fallbackFromAgent,
};

/** The tester-ops bot read a problem report in a DM: offer a ticket with that text. */
export async function offerTicketFromDm(openId: string, text: string): Promise<boolean> {
  const actor = await loadTicketActorByOpenId(openId);
  if (!actor) return false;
  const draft = (await openDraftOf(actor.id)) ?? (await prisma.ticketDraft.create({
    data: { workspaceId: actor.workspaceId, userId: actor.id, text: text.slice(0, TICKET_BODY_MAX) },
  }));
  await refreshDraftIntake(draft.id, actor);
  await showDraft(draft.id, openId);
  return true;
}

