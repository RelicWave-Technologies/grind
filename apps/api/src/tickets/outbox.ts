import crypto from 'node:crypto';
import { prisma } from '@grind/db';
import { TICKET_CLOSE_REASON_LABEL, type TicketStatus } from '@grind/types';
import { getLarkMessenger } from '../lark';
import { logger } from '../logger';
import { onShutdown } from '../lib/lifecycle';
import { reclaimStaleOutboxClaims } from '../lib/outboxReclaim';
import { LARK_CARD_UPDATE_WINDOW_MS } from '../access/larkOutbox';
import {
  buildAdminNoticeCard,
  buildAdminTicketCard,
  buildResolvedCard,
  buildUserNoticeCard,
} from './cards';
import { isLarkUnreachable, pinLarkMessage, unpinLarkMessage } from './larkApi';

/**
 * Delivery for ticket notices — the same claim / retry / reclaim shape as the
 * access-request outbox. Every event does two things:
 *
 * 1. Brings every admin's card up to date: sends it to admins who do not have
 *    it yet, rewrites it in place, pins it while the ticket is open and unpins
 *    it once it is resolved or closed. A card too old to update (14 days) is
 *    replaced by a fresh one.
 * 2. Tells whoever owes the next move: the requester about an admin's reply,
 *    question, resolve or close; the admins about the requester's reply or a
 *    reopen; an assignee about a ticket handed to them; reminders.
 *
 * A send is idempotent per (event, recipient) through Lark's uuid, so a retry
 * after a partial failure does not message anyone twice.
 */

const ACTIVE: TicketStatus[] = ['OPEN', 'IN_PROGRESS', 'WAITING_ON_USER'];

function retryDelayMs(attempts: number): number {
  return Math.min(15 * 60 * 1000, Math.max(1000, 1000 * 2 ** Math.min(attempts, 8)));
}

function truncateError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 1000);
}

/** Lark's uuid is at most 50 characters. */
function uuidFor(...parts: string[]): string {
  return crypto.createHash('sha1').update(parts.join(':')).digest('hex').slice(0, 40);
}

/**
 * Who gets a card: the admins picked in Policy, or every active admin. The
 * requester is left out when they are an admin themselves, unless nobody else
 * could take it.
 */
export async function resolveTicketAdminRecipients(
  workspaceId: string,
  requesterId: string | null,
): Promise<Array<{ userId: string; openId: string }>> {
  const [policy, admins] = await Promise.all([
    prisma.workspacePolicy.findUnique({ where: { workspaceId }, select: { ticketAdminIds: true } }),
    prisma.user.findMany({
      where: { workspaceId, role: 'ADMIN', provisioningStatus: 'ACTIVE', deactivatedAt: null },
      select: { id: true, larkIdentity: { select: { openId: true } } },
      orderBy: { name: 'asc' },
    }),
  ]);
  const chosen = new Set(policy?.ticketAdminIds ?? []);
  const picked = admins.filter((a) => chosen.has(a.id));
  let pool = picked.length > 0 ? picked : admins;
  const others = pool.filter((a) => a.id !== requesterId);
  if (others.length > 0) pool = others;
  return pool.flatMap((a) => (a.larkIdentity ? [{ userId: a.id, openId: a.larkIdentity.openId }] : []));
}

export async function loadTicketForCard(ticketId: string) {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: {
      workspace: { select: { timezone: true } },
      requester: {
        select: {
          id: true, name: true, agentVersion: true, deactivatedAt: true,
          team: { select: { name: true } }, unit: { select: { name: true } },
          larkIdentity: { select: { openId: true } },
        },
      },
      createdBy: { select: { id: true, name: true } },
      assignee: { select: { id: true, name: true, larkIdentity: { select: { openId: true } } } },
      _count: { select: { attachments: true } },
    },
  });
  if (!ticket) return null;
  const latest = await prisma.ticketEvent.findFirst({
    where: { ticketId, kind: 'COMMENT' },
    orderBy: { createdAt: 'desc' },
    select: { body: true, createdAt: true, actor: { select: { name: true } } },
  });
  return { ticket, latest };
}

type CardState = NonNullable<Awaited<ReturnType<typeof loadTicketForCard>>>;

export function adminCardFor(state: CardState): Record<string, unknown> {
  const { ticket, latest } = state;
  return buildAdminTicketCard({
    ticketId: ticket.id,
    number: ticket.number,
    subject: ticket.subject,
    description: ticket.description,
    category: ticket.category,
    priority: ticket.priority,
    status: ticket.status,
    closeReason: ticket.closeReason,
    requesterName: ticket.requester.name,
    requesterTeam: ticket.requester.team?.name ?? null,
    requesterUnit: ticket.requester.unit?.name ?? null,
    requesterVersion: ticket.requester.agentVersion,
    requesterUnreachable: ticket.requesterUnreachable,
    createdByName: ticket.createdBy.id === ticket.requester.id ? null : ticket.createdBy.name,
    assigneeName: ticket.assignee?.name ?? null,
    attachmentCount: ticket._count.attachments,
    createdAt: ticket.createdAt.getTime(),
    timeZone: ticket.workspace.timezone,
    latest: latest?.body ? { who: latest.actor?.name ?? 'Someone', body: latest.body, at: latest.createdAt.getTime() } : null,
  });
}

/** Bring every admin's card for this ticket up to date, pinned while it is open. */
async function syncAdminCards(state: CardState, opts: { resend: boolean }, now: Date): Promise<void> {
  const messenger = getLarkMessenger();
  if (!messenger) throw new Error('lark_not_configured');
  const { ticket } = state;
  const active = ACTIVE.includes(ticket.status);
  const card = adminCardFor(state);
  const recipients = await resolveTicketAdminRecipients(ticket.workspaceId, ticket.requesterId);
  const wanted = new Set(recipients.map((r) => r.openId));
  let firstError: unknown = null;

  // Admins who should have the card: send, refresh or replace it.
  for (const r of active ? recipients : []) {
    const ledger = await prisma.ticketLarkCard.upsert({
      where: { ticketId_recipientOpenId: { ticketId: ticket.id, recipientOpenId: r.openId } },
      create: { ticketId: ticket.id, recipientUserId: r.userId, recipientOpenId: r.openId },
      update: {},
    });
    const expired = ledger.sentAt && now.getTime() - ledger.sentAt.getTime() >= LARK_CARD_UPDATE_WINDOW_MS - 60 * 60 * 1000;
    try {
      if (ledger.messageId && ledger.status === 'SENT' && !expired && !opts.resend) {
        await messenger.updateCard(ledger.messageId, card);
        if (!ledger.pinned) await pin(ledger.id, ledger.messageId);
        continue;
      }
      // Replace an old or retired card with a fresh one, so the admin sees it again.
      if (ledger.messageId && ledger.pinned) await unpin(ledger.id, ledger.messageId);
      if (ledger.messageId && ledger.status === 'SENT') {
        await messenger.updateCard(ledger.messageId, card).catch(() => undefined);
      }
      const { messageId } = await messenger.sendCard(r.openId, card, uuidFor('ticket-card', ledger.id, String(ledger.attempts)));
      await prisma.ticketLarkCard.update({
        where: { id: ledger.id },
        data: { messageId, status: 'SENT', sentAt: now, attempts: { increment: 1 }, lastError: null, pinned: false },
      });
      await prisma.ticketLarkMessage.upsert({
        where: { messageId },
        create: { ticketId: ticket.id, messageId, recipientOpenId: r.openId, toAdmin: true },
        update: {},
      });
      await pin(ledger.id, messageId);
    } catch (err) {
      firstError ??= err;
      await prisma.ticketLarkCard.update({
        where: { id: ledger.id },
        data: { status: 'SEND_FAILED', attempts: { increment: 1 }, lastError: truncateError(err) },
      });
    }
  }

  // Cards that should no longer be pinned or current: closed/resolved tickets,
  // and admins who are no longer recipients.
  const existing = await prisma.ticketLarkCard.findMany({ where: { ticketId: ticket.id, messageId: { not: null } } });
  for (const ledger of existing) {
    const stillWanted = active && wanted.has(ledger.recipientOpenId);
    if (stillWanted) continue;
    try {
      if (ledger.pinned) await unpin(ledger.id, ledger.messageId!);
      const tooOld = ledger.sentAt && now.getTime() - ledger.sentAt.getTime() >= LARK_CARD_UPDATE_WINDOW_MS;
      if (!tooOld && ledger.status !== 'RETIRED') await messenger.updateCard(ledger.messageId!, card);
      if (!wanted.has(ledger.recipientOpenId) && ledger.status !== 'RETIRED') {
        await prisma.ticketLarkCard.update({ where: { id: ledger.id }, data: { status: 'RETIRED' } });
      }
    } catch (err) {
      logger.warn({ err: truncateError(err), ticketId: ticket.id, ledgerId: ledger.id }, 'ticket card refresh failed');
    }
  }
  if (firstError) throw firstError;
}

/** Pins are a convenience: a missing scope or a pin limit is logged, never fatal. */
async function pin(ledgerId: string, messageId: string) {
  try {
    await pinLarkMessage(messageId);
    await prisma.ticketLarkCard.update({ where: { id: ledgerId }, data: { pinned: true } });
  } catch (err) {
    logger.warn({ err: truncateError(err), messageId }, 'ticket card pin failed');
  }
}

async function unpin(ledgerId: string, messageId: string) {
  try {
    await unpinLarkMessage(messageId);
  } catch (err) {
    logger.warn({ err: truncateError(err), messageId }, 'ticket card unpin failed');
  }
  await prisma.ticketLarkCard.update({ where: { id: ledgerId }, data: { pinned: false } });
}

/** Message the requester. Unreachable people are flagged on the ticket instead of retried forever. */
async function sendToRequester(state: CardState, outboxId: string, card: Record<string, unknown>): Promise<void> {
  const { ticket } = state;
  const openId = ticket.requester.larkIdentity?.openId;
  if (ticket.requester.deactivatedAt) return;
  if (!openId) {
    if (!ticket.requesterUnreachable) {
      await prisma.ticket.update({ where: { id: ticket.id }, data: { requesterUnreachable: true } });
      state.ticket.requesterUnreachable = true;
    }
    return;
  }
  const messenger = getLarkMessenger();
  if (!messenger) throw new Error('lark_not_configured');
  try {
    const { messageId } = await messenger.sendCard(openId, card, uuidFor('ticket-user', outboxId, openId));
    await prisma.ticketLarkMessage.upsert({
      where: { messageId },
      create: { ticketId: ticket.id, messageId, recipientOpenId: openId, toAdmin: false },
      update: {},
    });
    if (ticket.requesterUnreachable) await prisma.ticket.update({ where: { id: ticket.id }, data: { requesterUnreachable: false } });
  } catch (err) {
    if (!isLarkUnreachable(err)) throw err;
    logger.warn({ ticketId: ticket.id, err: truncateError(err) }, 'ticket requester unreachable on Lark');
    if (!ticket.requesterUnreachable) {
      await prisma.ticket.update({ where: { id: ticket.id }, data: { requesterUnreachable: true } });
      state.ticket.requesterUnreachable = true;
    }
  }
}

/** Message some admins (a notice, not the card). */
async function sendToAdmins(
  state: CardState,
  outboxId: string,
  openIds: string[],
  card: Record<string, unknown>,
): Promise<void> {
  const messenger = getLarkMessenger();
  if (!messenger) throw new Error('lark_not_configured');
  let firstError: unknown = null;
  for (const openId of new Set(openIds)) {
    try {
      const { messageId } = await messenger.sendCard(openId, card, uuidFor('ticket-admin', outboxId, openId));
      await prisma.ticketLarkMessage.upsert({
        where: { messageId },
        create: { ticketId: state.ticket.id, messageId, recipientOpenId: openId, toAdmin: true },
        update: {},
      });
    } catch (err) {
      if (isLarkUnreachable(err)) continue;
      firstError ??= err;
    }
  }
  if (firstError) throw firstError;
}

/** The admins a requester-side notice should reach: the assignee, else every recipient. */
async function owningAdmins(state: CardState): Promise<string[]> {
  const assigneeOpenId = state.ticket.assignee?.larkIdentity?.openId;
  if (assigneeOpenId && state.ticket.assignee?.id !== state.ticket.requesterId) return [assigneeOpenId];
  const recipients = await resolveTicketAdminRecipients(state.ticket.workspaceId, state.ticket.requesterId);
  return recipients.map((r) => r.openId);
}

async function handleEvent(event: { id: string; ticketId: string; kind: string; eventId: string | null }, now: Date) {
  const state = await loadTicketForCard(event.ticketId);
  if (!state) return;
  const { ticket } = state;
  const ref = event.eventId
    ? await prisma.ticketEvent.findUnique({
      where: { id: event.eventId },
      select: { body: true, kind: true, actorId: true, meta: true, actor: { select: { name: true } } },
    })
    : null;
  const actorName = ref?.actor?.name ?? null;
  const base = { ticketId: ticket.id, number: ticket.number, subject: ticket.subject };
  const actorIsRequester = ref?.actorId === ticket.requesterId;
  const wasUnreachable = ticket.requesterUnreachable;

  switch (event.kind) {
    case 'CREATED': {
      await syncAdminCards(state, { resend: false }, now);
      const byAdmin = ticket.createdById !== ticket.requesterId;
      await sendToRequester(state, event.id, buildUserNoticeCard({
        ...base,
        title: byAdmin ? `${ticket.createdBy.name} opened ticket #${ticket.number} for you` : `Ticket #${ticket.number} received`,
        body: byAdmin ? ticket.description : 'Thanks. An admin will look at it and reply here on Lark.',
        canReply: true,
      }));
      break;
    }
    case 'COMMENT':
    case 'ASK_USER': {
      await syncAdminCards(state, { resend: false }, now);
      await sendToRequester(state, event.id, buildUserNoticeCard({
        ...base,
        title: event.kind === 'ASK_USER' ? `${actorName ?? 'An admin'} needs more information` : `Reply from ${actorName ?? 'an admin'}`,
        body: ref?.body ?? null,
        template: event.kind === 'ASK_USER' ? 'orange' : 'blue',
        canReply: true,
      }));
      break;
    }
    case 'USER_REPLY': {
      await syncAdminCards(state, { resend: false }, now);
      await sendToAdmins(state, event.id, await owningAdmins(state), buildAdminNoticeCard({
        ...base,
        title: `${ticket.requester.name} replied on #${ticket.number}`,
        body: ref?.body ?? null,
      }));
      break;
    }
    case 'REOPENED': {
      await syncAdminCards(state, { resend: true }, now);
      if (actorIsRequester) {
        await sendToAdmins(state, event.id, await owningAdmins(state), buildAdminNoticeCard({
          ...base,
          title: `${ticket.requester.name} reopened #${ticket.number}`,
          body: ref?.body ?? 'They say it is still a problem.',
          template: 'red',
        }));
      } else {
        await sendToRequester(state, event.id, buildUserNoticeCard({
          ...base,
          title: `#${ticket.number} reopened`,
          body: ref?.body ?? `${actorName ?? 'An admin'} reopened your ticket.`,
          template: 'orange',
          canReply: true,
        }));
      }
      break;
    }
    case 'RESOLVED': {
      await syncAdminCards(state, { resend: false }, now);
      await sendToRequester(state, event.id, buildResolvedCard({ ...base, resolvedBy: actorName, note: ref?.body ?? null }));
      break;
    }
    case 'CLOSED': {
      await syncAdminCards(state, { resend: false }, now);
      const reason = ticket.closeReason;
      if (reason === 'USER_CONFIRMED' || (reason === 'WITHDRAWN' && actorIsRequester)) break;
      const body = [reason ? TICKET_CLOSE_REASON_LABEL[reason] : null, ref?.body].filter(Boolean).join('\n');
      await sendToRequester(state, event.id, buildUserNoticeCard({
        ...base,
        title: `#${ticket.number} closed`,
        body: body || null,
        template: 'grey',
      }));
      if (reason === 'WITHDRAWN' || reason === 'AUTO_CONFIRMED' || reason === 'NO_RESPONSE') break;
      break;
    }
    case 'ASSIGNED':
    case 'STATUS': {
      await syncAdminCards(state, { resend: false }, now);
      const meta = (ref?.meta ?? {}) as { assigneeId?: string | null };
      const assignee = ticket.assignee;
      if (assignee && meta.assigneeId === assignee.id) {
        // Handed to someone other than the person who pressed it: tell them.
        if (ref?.actorId !== assignee.id && assignee.larkIdentity?.openId) {
          await sendToAdmins(state, event.id, [assignee.larkIdentity.openId], buildAdminNoticeCard({
            ...base,
            title: `#${ticket.number} assigned to you`,
            body: actorName ? `By ${actorName}` : null,
            template: 'blue',
          }));
        }
        if (assignee.id !== ticket.requesterId) {
          await sendToRequester(state, event.id, buildUserNoticeCard({
            ...base,
            title: `${assignee.name} is looking into #${ticket.number}`,
            body: null,
            canReply: true,
          }));
        }
      }
      break;
    }
    case 'ADMIN_REMINDER': {
      await syncAdminCards(state, { resend: true }, now);
      const waitedH = Math.max(1, Math.round((now.getTime() - ticket.lastUserActivityAt.getTime()) / 3_600_000));
      await sendToAdmins(state, event.id, await owningAdmins(state), buildAdminNoticeCard({
        ...base,
        title: `Reminder: #${ticket.number} is waiting for an admin`,
        body: `${ticket.requester.name} has been waiting about ${waitedH}h.`,
        template: 'red',
      }));
      break;
    }
    case 'USER_REMINDER': {
      if (ticket.status === 'RESOLVED') {
        await sendToRequester(state, event.id, buildResolvedCard({ ...base, resolvedBy: null, note: null, reminder: true }));
      } else if (ticket.status === 'WAITING_ON_USER') {
        const question = await prisma.ticketEvent.findFirst({
          where: { ticketId: ticket.id, kind: 'COMMENT', actorId: { not: ticket.requesterId } },
          orderBy: { createdAt: 'desc' },
          select: { body: true },
        });
        await sendToRequester(state, event.id, buildUserNoticeCard({
          ...base,
          title: `Reminder: #${ticket.number} needs your reply`,
          body: question?.body ?? null,
          template: 'orange',
          canReply: true,
        }));
      }
      break;
    }
    default:
      await syncAdminCards(state, { resend: false }, now);
  }
  // Learned just now that the requester cannot be reached: tell the admins on their cards.
  if (state.ticket.requesterUnreachable !== wasUnreachable) await syncAdminCards(state, { resend: false }, now);
}

export async function processTicketOutboxOnce(limit = 10, now: Date = new Date()): Promise<number> {
  await reclaimStaleOutboxClaims('ticket_lark', (cutoff) =>
    prisma.ticketOutboxEvent.updateMany({
      where: { status: 'PROCESSING', lockedAt: { lt: cutoff } },
      data: { status: 'PENDING', lockedAt: null, lockedBy: null },
    }),
  now);
  const workerId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const due = await prisma.ticketOutboxEvent.findMany({
    where: { status: 'PENDING', nextRunAt: { lte: now } },
    orderBy: [{ nextRunAt: 'asc' }, { createdAt: 'asc' }],
    take: limit,
  });
  let processed = 0;
  for (const event of due) {
    // One ticket's notices in order: wait while an earlier one is still pending.
    const earlier = await prisma.ticketOutboxEvent.count({
      where: { ticketId: event.ticketId, status: { in: ['PENDING', 'PROCESSING'] }, createdAt: { lt: event.createdAt } },
    });
    if (earlier > 0) continue;
    const claimed = await prisma.ticketOutboxEvent.updateMany({
      where: { id: event.id, status: 'PENDING' },
      data: { status: 'PROCESSING', lockedAt: new Date(), lockedBy: workerId },
    });
    if (claimed.count !== 1) continue;
    try {
      await handleEvent(event, now);
      await prisma.ticketOutboxEvent.update({
        where: { id: event.id },
        data: { status: 'DONE', processedAt: new Date(), lastError: null },
      });
      processed += 1;
    } catch (err) {
      const attempts = event.attempts + 1;
      await prisma.ticketOutboxEvent.update({
        where: { id: event.id },
        data: {
          status: attempts >= 25 ? 'FAILED' : 'PENDING',
          attempts,
          nextRunAt: new Date(Date.now() + retryDelayMs(attempts)),
          lockedAt: null,
          lockedBy: null,
          lastError: truncateError(err),
        },
      });
      logger.warn({ err: truncateError(err), eventId: event.id, kind: event.kind, attempts }, 'ticket Lark outbox event failed');
    }
  }
  return processed;
}

let timer: NodeJS.Timeout | null = null;

export function startTicketOutboxWorker(intervalMs = 5000): void {
  if (timer || process.env.NODE_ENV === 'test') return;
  timer = setInterval(() => {
    processTicketOutboxOnce().catch((err) => {
      logger.error({ err: String(err) }, 'ticket Lark outbox worker crashed');
    });
  }, intervalMs);
  timer.unref?.();
  onShutdown(() => {
    if (timer) clearInterval(timer);
    timer = null;
  });
}
