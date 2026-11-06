import { prisma } from '@grind/db';
import { getLarkMessenger } from '../lark';
import { logger } from '../logger';
import { onShutdown } from '../lib/lifecycle';
import { buildDigestCard } from './cards';
import { resolveTicketAdminRecipients } from './outbox';
import { applyTicketAction } from './service';

/**
 * The ticket clock, every 10 minutes:
 *
 * - Admins: a ticket waiting on an admin for 4h gets a reminder, then every 4h,
 *   at most 3 times until someone acts. One being worked on with nothing
 *   happening for 24h reminds its assignee.
 * - Requesters: asked a question, or asked "is it fixed?" — reminded after 24h
 *   (and 48h for a question). A resolved ticket closes itself after 3 days of
 *   silence, a waiting one after 5.
 * - A digest to every ticket admin at 10:00 when anything is open.
 * - Housekeeping: uploads never attached to anything, and stale Lark drafts.
 *
 * Messages only go out between 09:00 and 20:00 in the workspace's timezone; the
 * clock keeps counting overnight and catches up in the morning.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ADMIN_REMINDER_AFTER = 4 * HOUR;
const ADMIN_REMINDER_MAX = 3;
const ASSIGNEE_STALE_AFTER = DAY;
const AUTO_CONFIRM_AFTER = 3 * DAY;
const NO_RESPONSE_AFTER = 5 * DAY;
const DIGEST_HOUR = 10;

function localHour(now: Date, tz: string): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' }).format(now));
}

function localDay(now: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function withinMessagingHours(now: Date, tz: string): boolean {
  const h = localHour(now, tz);
  return h >= 9 && h < 20;
}

async function remindAdmins(workspaceId: string, now: Date): Promise<number> {
  const candidates = await prisma.ticket.findMany({
    where: { workspaceId, status: { in: ['OPEN', 'IN_PROGRESS'] } },
    select: {
      id: true, status: true, assigneeId: true, lastUserActivityAt: true, lastAdminActivityAt: true,
      statusChangedAt: true, adminReminderCount: true, lastAdminReminderAt: true,
    },
  });
  let queued = 0;
  for (const t of candidates) {
    const adminOwes = !t.lastAdminActivityAt || t.lastUserActivityAt > t.lastAdminActivityAt;
    const since = Math.max(t.lastUserActivityAt.getTime(), t.lastAdminReminderAt?.getTime() ?? 0);
    const waitingOnAdmin = adminOwes && t.adminReminderCount < ADMIN_REMINDER_MAX && now.getTime() - since >= ADMIN_REMINDER_AFTER;
    const lastTouch = Math.max(
      t.lastUserActivityAt.getTime(),
      t.lastAdminActivityAt?.getTime() ?? 0,
      t.statusChangedAt.getTime(),
      t.lastAdminReminderAt?.getTime() ?? 0,
    );
    const staleWithAssignee = !adminOwes && t.status === 'IN_PROGRESS' && t.assigneeId
      && t.adminReminderCount < ADMIN_REMINDER_MAX && now.getTime() - lastTouch >= ASSIGNEE_STALE_AFTER;
    if (!waitingOnAdmin && !staleWithAssignee) continue;
    // Claim by the counter so two instances never send the same reminder.
    const claimed = await prisma.ticket.updateMany({
      where: { id: t.id, adminReminderCount: t.adminReminderCount },
      data: { adminReminderCount: { increment: 1 }, lastAdminReminderAt: now },
    });
    if (claimed.count !== 1) continue;
    await prisma.ticketOutboxEvent.create({ data: { ticketId: t.id, kind: 'ADMIN_REMINDER' } });
    queued += 1;
  }
  return queued;
}

async function remindRequesters(workspaceId: string, now: Date, messaging: boolean): Promise<number> {
  const tickets = await prisma.ticket.findMany({
    where: { workspaceId, status: { in: ['WAITING_ON_USER', 'RESOLVED'] } },
    select: { id: true, status: true, statusChangedAt: true, userReminderCount: true },
  });
  let done = 0;
  for (const t of tickets) {
    const age = now.getTime() - t.statusChangedAt.getTime();
    const closeAfter = t.status === 'RESOLVED' ? AUTO_CONFIRM_AFTER : NO_RESPONSE_AFTER;
    if (age >= closeAfter) {
      const outcome = await applyTicketAction({
        ticketId: t.id,
        actor: 'system',
        action: { action: 'auto_close', reason: t.status === 'RESOLVED' ? 'AUTO_CONFIRMED' : 'NO_RESPONSE' },
        via: 'SYSTEM',
        now,
      });
      if (outcome.changed) done += 1;
      continue;
    }
    if (!messaging) continue;
    const dueCount = t.status === 'RESOLVED'
      ? (age >= DAY ? 1 : 0)
      : (age >= 2 * DAY ? 2 : age >= DAY ? 1 : 0);
    if (t.userReminderCount >= dueCount) continue;
    const claimed = await prisma.ticket.updateMany({
      where: { id: t.id, userReminderCount: t.userReminderCount, status: t.status },
      data: { userReminderCount: dueCount, lastUserReminderAt: now },
    });
    if (claimed.count !== 1) continue;
    await prisma.ticketOutboxEvent.create({ data: { ticketId: t.id, kind: 'USER_REMINDER' } });
    done += 1;
  }
  return done;
}

async function sendDigest(workspaceId: string, tz: string, now: Date): Promise<boolean> {
  if (localHour(now, tz) < DIGEST_HOUR) return false;
  const day = localDay(now, tz);
  const exists = await prisma.ticketDigest.findUnique({ where: { workspaceId_day: { workspaceId, day } } });
  if (exists) return false;
  const active = await prisma.ticket.findMany({
    where: { workspaceId, status: { in: ['OPEN', 'IN_PROGRESS', 'WAITING_ON_USER', 'RESOLVED'] } },
    select: {
      id: true, number: true, subject: true, status: true, assigneeId: true, createdAt: true,
      lastUserActivityAt: true, lastAdminActivityAt: true, requester: { select: { name: true } },
    },
    orderBy: { createdAt: 'asc' },
  });
  // Claim the day even when there is nothing to say, so the check is not repeated all day.
  const claimed = await prisma.ticketDigest.createMany({ data: [{ workspaceId, day }], skipDuplicates: true });
  if (claimed.count !== 1 || active.length === 0) return false;
  const messenger = getLarkMessenger();
  if (!messenger) return false;
  const needAdmin = active.filter((t) => t.status === 'OPEN' || t.status === 'IN_PROGRESS');
  const card = buildDigestCard({
    date: day,
    open: needAdmin.length,
    unassigned: needAdmin.filter((t) => !t.assigneeId).length,
    waitingOnUser: active.filter((t) => t.status === 'WAITING_ON_USER').length,
    resolved: active.filter((t) => t.status === 'RESOLVED').length,
    oldest: needAdmin.slice(0, 8).map((t) => ({
      id: t.id,
      number: t.number,
      subject: t.subject,
      requester: t.requester.name,
      ageDays: Math.floor((now.getTime() - t.createdAt.getTime()) / DAY),
      status: t.status,
    })),
  });
  const recipients = await resolveTicketAdminRecipients(workspaceId, null);
  for (const r of recipients) {
    await messenger.sendCard(r.openId, card, `tdg-${workspaceId.slice(-12)}-${day}-${r.userId.slice(-12)}`)
      .catch((err) => logger.warn({ err: String(err), userId: r.userId }, 'ticket digest send failed'));
  }
  return true;
}

async function housekeeping(now: Date): Promise<void> {
  await prisma.ticketAttachment.deleteMany({
    where: { ticketId: null, createdAt: { lt: new Date(now.getTime() - DAY) } },
  });
  await prisma.ticketDraft.updateMany({
    where: { status: 'OPEN', updatedAt: { lt: new Date(now.getTime() - 2 * DAY) } },
    data: { status: 'CANCELLED' },
  });
  await prisma.ticketInboundMessage.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 7 * DAY) } } });
}

export async function runTicketSchedulerOnce(now: Date = new Date()): Promise<void> {
  // One instance at a time.
  const locked = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext('ticket-scheduler')) AS locked`;
    if (!rows[0]?.locked) return false;
    const workspaces = await tx.workspace.findMany({ select: { id: true, timezone: true } });
    for (const ws of workspaces) {
      const messaging = withinMessagingHours(now, ws.timezone);
      if (messaging) await remindAdmins(ws.id, now);
      await remindRequesters(ws.id, now, messaging);
      if (messaging) await sendDigest(ws.id, ws.timezone, now);
    }
    return true;
  }, { timeout: 120_000 });
  if (locked) await housekeeping(now);
}

let timer: NodeJS.Timeout | null = null;

export function startTicketScheduler(intervalMs = 10 * 60 * 1000): void {
  if (timer || process.env.NODE_ENV === 'test') return;
  const run = () => {
    runTicketSchedulerOnce().catch((err) => logger.error({ err: String(err) }, 'ticket scheduler failed'));
  };
  setTimeout(run, 60_000).unref?.();
  timer = setInterval(run, intervalMs);
  timer.unref?.();
  onShutdown(() => {
    if (timer) clearInterval(timer);
    timer = null;
  });
}
