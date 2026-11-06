import { prisma, type Prisma } from '@grind/db';
import {
  hasPermission,
  TICKET_ATTACHMENTS_PER_POST,
  TICKET_REOPEN_WINDOW_DAYS,
  type TicketActionRequest,
  type TicketCategory,
  type TicketPriority,
  type TicketStatus,
} from '@grind/types';

/**
 * Support tickets: every change goes through here, whether it came from the
 * dashboard, a Lark card button, a Lark DM or the reminder job. Each change
 * takes a row lock on the ticket, writes an event for the thread and queues
 * the Lark notices in the same transaction, so a notice never goes out for a
 * change that rolled back and a double click changes a ticket once.
 */

type Tx = Prisma.TransactionClient;
export type TicketVia = 'DASHBOARD' | 'LARK' | 'SYSTEM';

export type TicketErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'requester_invalid'
  | 'attachment_invalid'
  | 'rate_limited'
  | 'invalid_transition'
  | 'reopen_window_passed'
  | 'duplicate_invalid'
  | 'assignee_invalid'
  | 'ticket_closed';

export class TicketError extends Error {
  constructor(readonly code: TicketErrorCode, readonly status: number) {
    super(code);
  }
}

/** Who is acting, as the ticket rules see them. */
export type TicketActor = { id: string; workspaceId: string; name: string; isAdmin: boolean };

const ACTIVE: TicketStatus[] = ['OPEN', 'IN_PROGRESS', 'WAITING_ON_USER'];
const DAILY_TICKET_LIMIT = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

export function isTicketAdminRole(role: 'ADMIN' | 'MANAGER' | 'MEMBER' | 'HR'): boolean {
  return hasPermission(role, 'tickets.manage');
}

/** The acting user, or null when they cannot act (unknown, suspended, still waiting for access). */
export async function loadTicketActor(userId: string): Promise<TicketActor | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, workspaceId: true, name: true, role: true, provisioningStatus: true, deactivatedAt: true },
  });
  if (!user || user.deactivatedAt || user.provisioningStatus !== 'ACTIVE') return null;
  return { id: user.id, workspaceId: user.workspaceId, name: user.name, isAdmin: isTicketAdminRole(user.role) };
}

export async function loadTicketActorByOpenId(openId: string): Promise<TicketActor | null> {
  const identity = await prisma.larkIdentity.findUnique({ where: { openId }, select: { userId: true } });
  return identity ? loadTicketActor(identity.userId) : null;
}

async function lockTicket(tx: Tx, ticketId: string) {
  await tx.$queryRaw`SELECT id FROM "Ticket" WHERE id = ${ticketId} FOR UPDATE`;
  return tx.ticket.findUnique({ where: { id: ticketId } });
}

async function nextNumber(tx: Tx, workspaceId: string): Promise<number> {
  // One writer at a time per workspace, so two tickets never share a number.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`ticket-number:${workspaceId}`}))`;
  const last = await tx.ticket.aggregate({ where: { workspaceId }, _max: { number: true } });
  return (last._max.number ?? 0) + 1;
}

/**
 * Attach uploads to a ticket or comment. Only the uploader's own, still
 * unbound, uploads from the last day count; anything else is refused rather
 * than silently dropped, so nobody can bind someone else's file.
 */
async function bindAttachments(
  tx: Tx,
  args: { ids: string[]; uploaderId: string; ticketId: string; eventId: string; draftId?: string | null },
): Promise<void> {
  const ids = [...new Set(args.ids)];
  if (ids.length === 0) return;
  if (ids.length > TICKET_ATTACHMENTS_PER_POST) throw new TicketError('attachment_invalid', 400);
  const bound = await tx.ticketAttachment.updateMany({
    where: {
      id: { in: ids },
      uploaderId: args.uploaderId,
      ticketId: null,
      createdAt: { gte: new Date(Date.now() - DAY_MS) },
      ...(args.draftId ? { OR: [{ draftId: null }, { draftId: args.draftId }] } : { draftId: null }),
    },
    data: { ticketId: args.ticketId, eventId: args.eventId },
  });
  if (bound.count !== ids.length) throw new TicketError('attachment_invalid', 400);
}

async function queue(tx: Tx, ticketId: string, kind: Prisma.TicketOutboxEventCreateManyInput['kind'], eventId?: string) {
  await tx.ticketOutboxEvent.create({ data: { ticketId, kind, eventId: eventId ?? null } });
}

export async function createTicket(args: {
  actor: TicketActor;
  requesterId?: string;
  subject: string;
  description: string;
  category: TicketCategory;
  priority?: TicketPriority;
  via: TicketVia;
  attachmentIds?: string[];
  /** Images collected in a Lark DM draft. */
  draftId?: string;
  idempotencyKey?: string;
  now?: Date;
}) {
  const now = args.now ?? new Date();
  const forSomeoneElse = Boolean(args.requesterId && args.requesterId !== args.actor.id);
  if (forSomeoneElse && !args.actor.isAdmin) throw new TicketError('forbidden', 403);
  if (args.priority && args.priority !== 'NORMAL' && !args.actor.isAdmin) throw new TicketError('forbidden', 403);
  const requesterId = args.requesterId ?? args.actor.id;

  if (args.idempotencyKey) {
    const existing = await prisma.ticket.findUnique({
      where: { createdById_idempotencyKey: { createdById: args.actor.id, idempotencyKey: args.idempotencyKey } },
    });
    if (existing) return existing;
  }

  if (forSomeoneElse) {
    const requester = await prisma.user.findUnique({
      where: { id: requesterId },
      select: { workspaceId: true, deactivatedAt: true },
    });
    if (!requester || requester.workspaceId !== args.actor.workspaceId || requester.deactivatedAt) {
      throw new TicketError('requester_invalid', 400);
    }
  } else if (!args.actor.isAdmin) {
    const today = await prisma.ticket.count({
      where: { createdById: args.actor.id, createdAt: { gte: new Date(now.getTime() - DAY_MS) } },
    });
    if (today >= DAILY_TICKET_LIMIT) throw new TicketError('rate_limited', 429);
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const number = await nextNumber(tx, args.actor.workspaceId);
      const ticket = await tx.ticket.create({
        data: {
          workspaceId: args.actor.workspaceId,
          number,
          subject: args.subject,
          description: args.description,
          category: args.category,
          priority: args.priority ?? 'NORMAL',
          source: forSomeoneElse ? 'ADMIN' : args.via === 'LARK' ? 'LARK' : 'DASHBOARD',
          requesterId,
          createdById: args.actor.id,
          idempotencyKey: args.idempotencyKey ?? null,
          statusChangedAt: now,
          lastUserActivityAt: now,
          // An admin filing for someone has already looked at it.
          ...(forSomeoneElse ? { lastAdminActivityAt: now, firstAdminResponseAt: now } : {}),
        },
      });
      const event = await tx.ticketEvent.create({
        data: { ticketId: ticket.id, kind: 'CREATED', actorId: args.actor.id, toStatus: 'OPEN', via: args.via },
      });
      await bindAttachments(tx, {
        ids: args.attachmentIds ?? [],
        uploaderId: args.actor.id,
        ticketId: ticket.id,
        eventId: event.id,
      });
      if (args.draftId) {
        await tx.ticketAttachment.updateMany({
          where: { draftId: args.draftId, ticketId: null },
          data: { ticketId: ticket.id, eventId: event.id },
        });
        await tx.ticketDraft.update({ where: { id: args.draftId }, data: { status: 'USED', ticketId: ticket.id } });
      }
      await queue(tx, ticket.id, 'CREATED', event.id);
      return ticket;
    });
  } catch (err) {
    // Two identical submits raced past the lookup: the loser gets the winner's ticket.
    if (args.idempotencyKey && (err as { code?: string }).code === 'P2002') {
      const existing = await prisma.ticket.findUnique({
        where: { createdById_idempotencyKey: { createdById: args.actor.id, idempotencyKey: args.idempotencyKey } },
      });
      if (existing) return existing;
    }
    throw err;
  }
}

function assertCanSee(ticket: { workspaceId: string; requesterId: string }, actor: TicketActor) {
  if (ticket.workspaceId !== actor.workspaceId) throw new TicketError('not_found', 404);
  if (!actor.isAdmin && ticket.requesterId !== actor.id) throw new TicketError('not_found', 404);
}

/**
 * A reply on the thread. The requester answering moves a waiting ticket back
 * to the admins and reopens a resolved one ("still a problem"); an admin's
 * reply starts work on an open ticket, and a question parks it on the
 * requester. An internal note changes nothing and reaches nobody on Lark.
 */
export async function addTicketComment(args: {
  ticketId: string;
  actor: TicketActor;
  body: string;
  internal?: boolean;
  askUser?: boolean;
  attachmentIds?: string[];
  via: TicketVia;
  meta?: Record<string, unknown>;
  now?: Date;
}) {
  const now = args.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const ticket = await lockTicket(tx, args.ticketId);
    if (!ticket) throw new TicketError('not_found', 404);
    assertCanSee(ticket, args.actor);
    const isRequester = ticket.requesterId === args.actor.id;
    if ((args.internal || args.askUser) && !args.actor.isAdmin) throw new TicketError('forbidden', 403);

    // The requester speaking for themselves is the requester, even if they are an admin too.
    const speaksAsRequester = isRequester && !args.internal && !args.askUser;
    const asAdmin = args.actor.isAdmin && !speaksAsRequester;
    if (speaksAsRequester && ticket.status === 'CLOSED') throw new TicketError('ticket_closed', 409);

    let nextStatus: TicketStatus = ticket.status;
    if (speaksAsRequester) {
      if (ticket.status === 'WAITING_ON_USER') nextStatus = 'IN_PROGRESS';
      else if (ticket.status === 'RESOLVED') nextStatus = 'OPEN';
    } else if (asAdmin && !args.internal) {
      if (args.askUser && ticket.status !== 'CLOSED') nextStatus = 'WAITING_ON_USER';
      else if (ticket.status === 'OPEN') nextStatus = 'IN_PROGRESS';
    }

    const event = await tx.ticketEvent.create({
      data: {
        ticketId: ticket.id,
        kind: args.internal ? 'INTERNAL_NOTE' : 'COMMENT',
        actorId: args.actor.id,
        body: args.body,
        via: args.via,
        ...(args.meta ? { meta: args.meta as Prisma.InputJsonValue } : {}),
      },
    });
    await bindAttachments(tx, {
      ids: args.attachmentIds ?? [],
      uploaderId: args.actor.id,
      ticketId: ticket.id,
      eventId: event.id,
    });

    const data: Prisma.TicketUpdateInput = {};
    if (speaksAsRequester) {
      data.lastUserActivityAt = now;
      data.userReminderCount = 0;
      data.adminReminderCount = 0;
    } else if (!args.internal) {
      data.lastAdminActivityAt = now;
      data.firstAdminResponseAt = ticket.firstAdminResponseAt ?? now;
      data.adminReminderCount = 0;
      if (!ticket.assigneeId) data.assignee = { connect: { id: args.actor.id } };
    }
    if (nextStatus !== ticket.status) {
      Object.assign(data, statusChange(ticket.status, nextStatus, now));
      await tx.ticketEvent.create({
        data: { ticketId: ticket.id, kind: 'STATUS', actorId: args.actor.id, fromStatus: ticket.status, toStatus: nextStatus, via: args.via },
      });
    }
    if (Object.keys(data).length > 0) await tx.ticket.update({ where: { id: ticket.id }, data });

    if (!args.internal) {
      const kind = speaksAsRequester
        ? nextStatus === 'OPEN' && ticket.status === 'RESOLVED' ? 'REOPENED' : 'USER_REPLY'
        : args.askUser ? 'ASK_USER' : 'COMMENT';
      await queue(tx, ticket.id, kind, event.id);
    }
    return { ticket: { ...ticket, status: nextStatus }, eventId: event.id };
  });
}

/** Fields that move with a status: when it changed, and the resolve/close stamps. */
function statusChange(from: TicketStatus, to: TicketStatus, now: Date): Prisma.TicketUpdateInput {
  const data: Prisma.TicketUpdateInput = { status: to, statusChangedAt: now, userReminderCount: 0, lastUserReminderAt: null };
  if (to === 'RESOLVED') data.resolvedAt = now;
  if (to === 'CLOSED') data.closedAt = now;
  if (ACTIVE.includes(to)) {
    data.closeReason = null;
    if (from === 'RESOLVED' || from === 'CLOSED') {
      data.resolvedAt = null;
      data.closedAt = null;
      data.adminReminderCount = 0;
      data.lastAdminReminderAt = null;
    }
  }
  return data;
}

export type TicketActionOutcome = { ticketId: string; changed: boolean; status: TicketStatus };

/**
 * Move a ticket. Admin actions: start, assign, resolve, close, duplicate,
 * priority, category. Requester actions: withdraw, confirm, reopen (an admin
 * may reopen too). A repeat of an action already taken (two admins pressing
 * Resolve) changes nothing and reports `changed: false`.
 */
export async function applyTicketAction(args: {
  ticketId: string;
  actor: TicketActor | 'system';
  action: TicketActionRequest | { action: 'auto_close'; reason: 'AUTO_CONFIRMED' | 'NO_RESPONSE' };
  via: TicketVia;
  now?: Date;
}): Promise<TicketActionOutcome> {
  const now = args.now ?? new Date();
  const actor = args.actor;
  const actorId = actor === 'system' ? null : actor.id;
  const a = args.action;

  return prisma.$transaction(async (tx) => {
    const ticket = await lockTicket(tx, args.ticketId);
    if (!ticket) throw new TicketError('not_found', 404);
    if (actor !== 'system') assertCanSee(ticket, actor);
    const isAdmin = actor === 'system' || actor.isAdmin;
    const isRequester = actor !== 'system' && ticket.requesterId === actor.id;
    const adminOnly = () => {
      if (!isAdmin) throw new TicketError('forbidden', 403);
    };
    const unchanged = { ticketId: ticket.id, changed: false, status: ticket.status } as const;

    let to: TicketStatus = ticket.status;
    let closeReason: Prisma.TicketUpdateInput['closeReason'] | undefined;
    let note: string | undefined;
    let kind: 'STATUS' | 'RESOLVED' | 'CLOSED' | 'REOPENED' | 'ASSIGNED' | 'REFRESH' = 'STATUS';
    const extra: Prisma.TicketUpdateInput = {};
    const extraEvents: Array<Omit<Prisma.TicketEventCreateManyInput, 'ticketId'>> = [];

    switch (a.action) {
      case 'start': {
        adminOnly();
        if (ticket.status === 'IN_PROGRESS' && ticket.assigneeId) return unchanged;
        if (!['OPEN', 'WAITING_ON_USER', 'IN_PROGRESS'].includes(ticket.status)) throw new TicketError('invalid_transition', 409);
        to = 'IN_PROGRESS';
        if (!ticket.assigneeId && actorId) {
          extra.assignee = { connect: { id: actorId } };
          extraEvents.push({ kind: 'ASSIGNED', actorId, via: args.via, meta: { assigneeId: actorId } });
        }
        extra.lastAdminActivityAt = now;
        extra.firstAdminResponseAt = ticket.firstAdminResponseAt ?? now;
        kind = 'ASSIGNED';
        break;
      }
      case 'assign': {
        adminOnly();
        if (a.assigneeId === ticket.assigneeId) return unchanged;
        if (a.assigneeId) {
          const assignee = await tx.user.findUnique({
            where: { id: a.assigneeId },
            select: { workspaceId: true, role: true, deactivatedAt: true, provisioningStatus: true },
          });
          if (!assignee || assignee.workspaceId !== ticket.workspaceId || assignee.deactivatedAt
            || assignee.provisioningStatus !== 'ACTIVE' || !isTicketAdminRole(assignee.role)) {
            throw new TicketError('assignee_invalid', 400);
          }
          extra.assignee = { connect: { id: a.assigneeId } };
        } else {
          extra.assignee = { disconnect: true };
        }
        extraEvents.push({ kind: 'ASSIGNED', actorId, via: args.via, meta: { assigneeId: a.assigneeId } });
        kind = 'ASSIGNED';
        break;
      }
      case 'resolve': {
        adminOnly();
        if (ticket.status === 'RESOLVED') return unchanged;
        if (!ACTIVE.includes(ticket.status)) throw new TicketError('invalid_transition', 409);
        to = 'RESOLVED';
        note = a.note || undefined;
        extra.lastAdminActivityAt = now;
        extra.firstAdminResponseAt = ticket.firstAdminResponseAt ?? now;
        if (!ticket.assigneeId && actorId) extra.assignee = { connect: { id: actorId } };
        kind = 'RESOLVED';
        break;
      }
      case 'close': {
        adminOnly();
        if (ticket.status === 'CLOSED') return unchanged;
        to = 'CLOSED';
        closeReason = 'ADMIN';
        note = a.note || undefined;
        kind = 'CLOSED';
        break;
      }
      case 'duplicate': {
        adminOnly();
        if (ticket.status === 'CLOSED') return unchanged;
        const original = await tx.ticket.findUnique({
          where: { workspaceId_number: { workspaceId: ticket.workspaceId, number: a.ofNumber } },
          select: { id: true, number: true },
        });
        if (!original || original.id === ticket.id) throw new TicketError('duplicate_invalid', 400);
        to = 'CLOSED';
        closeReason = 'DUPLICATE';
        extra.duplicateOf = { connect: { id: original.id } };
        note = `Duplicate of #${original.number}`;
        kind = 'CLOSED';
        break;
      }
      case 'withdraw': {
        if (!isRequester) throw new TicketError('forbidden', 403);
        if (ticket.status === 'CLOSED') return unchanged;
        to = 'CLOSED';
        closeReason = 'WITHDRAWN';
        note = a.note || undefined;
        extra.lastUserActivityAt = now;
        kind = 'CLOSED';
        break;
      }
      case 'confirm': {
        if (!isRequester) throw new TicketError('forbidden', 403);
        if (ticket.status === 'CLOSED' && ticket.closeReason === 'USER_CONFIRMED') return unchanged;
        if (ticket.status !== 'RESOLVED') throw new TicketError('invalid_transition', 409);
        to = 'CLOSED';
        closeReason = 'USER_CONFIRMED';
        extra.lastUserActivityAt = now;
        kind = 'CLOSED';
        break;
      }
      case 'reopen': {
        if (!isRequester && !isAdmin) throw new TicketError('forbidden', 403);
        if (ACTIVE.includes(ticket.status)) return unchanged;
        if (!isAdmin) {
          if (ticket.closeReason === 'DUPLICATE') throw new TicketError('invalid_transition', 409);
          const closedAt = ticket.closedAt?.getTime();
          if (ticket.status === 'CLOSED' && closedAt && now.getTime() - closedAt > TICKET_REOPEN_WINDOW_DAYS * DAY_MS) {
            throw new TicketError('reopen_window_passed', 409);
          }
          extra.lastUserActivityAt = now;
        }
        to = 'OPEN';
        note = a.note || undefined;
        extra.duplicateOf = ticket.duplicateOfId ? { disconnect: true } : undefined;
        kind = 'REOPENED';
        break;
      }
      case 'priority': {
        adminOnly();
        if (a.priority === ticket.priority) return unchanged;
        extra.priority = a.priority;
        extraEvents.push({ kind: 'PRIORITY', actorId, via: args.via, meta: { from: ticket.priority, to: a.priority } });
        kind = 'REFRESH';
        break;
      }
      case 'category': {
        adminOnly();
        if (a.category === ticket.category) return unchanged;
        extra.category = a.category;
        extraEvents.push({ kind: 'PRIORITY', actorId, via: args.via, meta: { categoryFrom: ticket.category, categoryTo: a.category } });
        kind = 'REFRESH';
        break;
      }
      case 'auto_close': {
        if (actor !== 'system') throw new TicketError('forbidden', 403);
        const expected = a.reason === 'AUTO_CONFIRMED' ? 'RESOLVED' : 'WAITING_ON_USER';
        if (ticket.status !== expected) return unchanged;
        to = 'CLOSED';
        closeReason = a.reason;
        kind = 'CLOSED';
        break;
      }
    }

    const data: Prisma.TicketUpdateInput = { ...extra };
    let statusEventId: string | undefined;
    if (to !== ticket.status) {
      Object.assign(data, statusChange(ticket.status, to, now));
      if (closeReason) data.closeReason = closeReason;
      const event = await tx.ticketEvent.create({
        data: {
          ticketId: ticket.id,
          kind: 'STATUS',
          actorId,
          fromStatus: ticket.status,
          toStatus: to,
          body: note ?? null,
          via: args.via,
          ...(closeReason ? { meta: { closeReason } } : {}),
        },
      });
      statusEventId = event.id;
    }
    for (const e of extraEvents) {
      const created = await tx.ticketEvent.create({ data: { ...e, ticketId: ticket.id } });
      statusEventId ??= created.id;
    }
    await tx.ticket.update({ where: { id: ticket.id }, data });
    await queue(tx, ticket.id, kind, statusEventId);
    return { ticketId: ticket.id, changed: true, status: to };
  });
}
