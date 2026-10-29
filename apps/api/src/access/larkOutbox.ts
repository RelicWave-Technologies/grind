import { prisma } from '@grind/db';
import { getLarkMessenger } from '../lark';
import { buildAccessRequestCard } from '../lark/accessCards';
import { logger } from '../logger';
import { onShutdown } from '../lib/lifecycle';
import { reclaimStaleOutboxClaims } from '../lib/outboxReclaim';
import { decidedCardFor, loadAccessCardState, resolveAccessRequestRecipients } from './requests';

/**
 * Delivery for access-request cards — the same claim / retry / reclaim shape
 * as the manual-time Lark outbox. SEND_CARDS fans one card out per recipient
 * (a ledger row each, its id doubling as Lark's idempotency key);
 * FINALIZE_CARDS rewrites every sent card once someone decides.
 */

/** Lark refuses to update a card message older than this. */
export const LARK_CARD_UPDATE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function retryDelayMs(attempts: number): number {
  return Math.min(15 * 60 * 1000, Math.max(1000, 1000 * 2 ** Math.min(attempts, 8)));
}

function truncateError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.slice(0, 1000);
}

async function pendingCardFor(state: NonNullable<Awaited<ReturnType<typeof loadAccessCardState>>>) {
  const workspaceId = state.req.user.workspaceId;
  const [teams, shifts] = await Promise.all([
    prisma.team.findMany({ where: { workspaceId }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    prisma.shift.findMany({
      where: { workspaceId },
      select: { id: true, name: true, _count: { select: { members: true } } },
      orderBy: { name: 'asc' },
    }),
  ]);
  // Pre-pick the shift most people are on; ties go to the first by name.
  const defaultShift = shifts.reduce<(typeof shifts)[number] | null>(
    (best, s) => (!best || s._count.members > best._count.members ? s : best),
    null,
  );
  return buildAccessRequestCard({
    accessRequestId: state.req.id,
    name: state.req.user.name,
    email: state.req.user.email,
    requestedAt: state.req.createdAt.getTime(),
    timeZone: state.req.user.workspace.timezone,
    teams,
    shifts: shifts.map((s) => ({ id: s.id, name: s.name })),
    defaultShiftId: defaultShift?.id ?? null,
  });
}

async function handleSendCards(accessRequestId: string): Promise<void> {
  const messenger = getLarkMessenger();
  if (!messenger) throw new Error('lark_not_configured');
  const state = await loadAccessCardState(accessRequestId);
  if (!state) return; // person deleted; nothing to ask about
  if (state.req.status !== 'PENDING') return; // decided before the cards went out

  const recipients = await resolveAccessRequestRecipients(state.req.user.workspaceId);
  if (recipients.length === 0) {
    logger.warn({ accessRequestId }, 'access request: no admin with a Lark identity to send the card to');
    return;
  }
  const card = await pendingCardFor(state);
  let firstError: unknown = null;
  for (const recipient of recipients) {
    const ledger = await prisma.accessRequestLarkMessage.upsert({
      where: { accessRequestId_recipientOpenId: { accessRequestId, recipientOpenId: recipient.openId } },
      create: { accessRequestId, recipientOpenId: recipient.openId },
      update: {},
    });
    if (ledger.status === 'SENT' && ledger.messageId) continue;
    try {
      const { messageId } = await messenger.sendCard(recipient.openId, card, ledger.id);
      await prisma.accessRequestLarkMessage.update({
        where: { id: ledger.id },
        data: { messageId, status: 'SENT', attempts: { increment: 1 }, lastError: null, sentAt: new Date() },
      });
    } catch (err) {
      firstError ??= err;
      await prisma.accessRequestLarkMessage.update({
        where: { id: ledger.id },
        data: { status: 'SEND_FAILED', attempts: { increment: 1 }, lastError: truncateError(err) },
      });
    }
  }
  if (firstError) throw firstError;
}

async function handleFinalizeCards(accessRequestId: string, now: Date): Promise<void> {
  const messenger = getLarkMessenger();
  if (!messenger) throw new Error('lark_not_configured');
  const state = await loadAccessCardState(accessRequestId);
  if (!state || state.req.status === 'PENDING') return;
  const card = decidedCardFor(state);
  const messages = await prisma.accessRequestLarkMessage.findMany({
    where: { accessRequestId, messageId: { not: null }, status: { in: ['SENT', 'UPDATE_FAILED'] } },
    orderBy: { createdAt: 'asc' },
  });
  let firstError: unknown = null;
  for (const message of messages) {
    if (message.sentAt && now.getTime() - message.sentAt.getTime() >= LARK_CARD_UPDATE_WINDOW_MS) {
      await prisma.accessRequestLarkMessage.update({ where: { id: message.id }, data: { status: 'EXPIRED' } });
      continue;
    }
    try {
      await messenger.updateCard(message.messageId!, card);
      await prisma.accessRequestLarkMessage.update({
        where: { id: message.id },
        data: { status: 'DECIDED', lastError: null },
      });
    } catch (err) {
      firstError ??= err;
      await prisma.accessRequestLarkMessage.update({
        where: { id: message.id },
        data: { status: 'UPDATE_FAILED', attempts: { increment: 1 }, lastError: truncateError(err) },
      });
    }
  }
  // Cards that never went out stay unsent.
  await prisma.accessRequestLarkMessage.updateMany({
    where: { accessRequestId, messageId: null, status: { in: ['PENDING', 'SEND_FAILED'] } },
    data: { status: 'DECIDED' },
  });
  if (firstError) throw firstError;
}

export async function processAccessRequestLarkOutboxOnce(limit = 10, now: Date = new Date()): Promise<number> {
  await reclaimStaleOutboxClaims('access_request_lark', (cutoff) =>
    prisma.accessRequestLarkOutboxEvent.updateMany({
      where: { status: 'PROCESSING', lockedAt: { lt: cutoff } },
      data: { status: 'PENDING', lockedAt: null, lockedBy: null },
    }),
  now);
  const workerId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const due = await prisma.accessRequestLarkOutboxEvent.findMany({
    where: { status: 'PENDING', nextRunAt: { lte: now } },
    orderBy: [{ nextRunAt: 'asc' }, { createdAt: 'asc' }],
    take: limit,
  });
  let processed = 0;
  for (const event of due) {
    const claimed = await prisma.accessRequestLarkOutboxEvent.updateMany({
      where: { id: event.id, status: 'PENDING' },
      data: { status: 'PROCESSING', lockedAt: new Date(), lockedBy: workerId },
    });
    if (claimed.count !== 1) continue;
    try {
      if (event.kind === 'SEND_CARDS') await handleSendCards(event.accessRequestId);
      else await handleFinalizeCards(event.accessRequestId, now);
      await prisma.accessRequestLarkOutboxEvent.update({
        where: { id: event.id },
        data: { status: 'DONE', processedAt: new Date(), lastError: null },
      });
      processed += 1;
    } catch (err) {
      const attempts = event.attempts + 1;
      await prisma.accessRequestLarkOutboxEvent.update({
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
      logger.warn({ err: truncateError(err), eventId: event.id, kind: event.kind, attempts }, 'access request Lark outbox event failed');
    }
  }
  return processed;
}

let timer: NodeJS.Timeout | null = null;

export function startAccessRequestLarkOutboxWorker(intervalMs = 5000): void {
  if (timer || process.env.NODE_ENV === 'test') return;
  timer = setInterval(() => {
    processAccessRequestLarkOutboxOnce().catch((err) => {
      logger.error({ err: String(err) }, 'access request Lark outbox worker crashed');
    });
  }, intervalMs);
  timer.unref?.();
  onShutdown(() => {
    if (timer) clearInterval(timer);
    timer = null;
  });
}
