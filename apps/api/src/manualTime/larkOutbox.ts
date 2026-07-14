import { prisma, type Prisma } from '@grind/db';
import {
  buildApprovalCard,
  buildCancelledCard,
  buildDecidedCard,
  buildStaleRequestCard,
  buildUpdatedApprovalCard,
  getLarkMessenger,
  type DiffEntry,
} from '../lark';
import { logger } from '../logger';

type Tx = Prisma.TransactionClient;
type LarkMessageKind = 'APPROVAL' | 'UPDATED_APPROVAL' | 'DECIDED_NOTICE';
type OutboxKind = 'SEND_CARD' | 'SUPERSEDE_OLD_CARDS' | 'FINALIZE_CARDS';

interface QueueApprovalCardArgs {
  requestId: string;
  version: number;
  recipientOpenId: string;
  kind: LarkMessageKind;
  diff?: DiffEntry[];
}

export async function queueManualTimeApprovalCard(tx: Tx, args: QueueApprovalCardArgs): Promise<string> {
  const diff = (args.diff ?? []).map((d) => ({ label: d.label, before: d.before, after: d.after }));
  const message = await tx.manualTimeLarkMessage.create({
    data: {
      requestId: args.requestId,
      version: args.version,
      recipientOpenId: args.recipientOpenId,
      kind: args.kind,
    },
  });
  await tx.manualTimeLarkOutboxEvent.create({
    data: {
      requestId: args.requestId,
      messageLedgerId: message.id,
      kind: 'SEND_CARD',
      payload: { diff },
    },
  });
  return message.id;
}

export async function queueManualTimeSupersedeOldCards(tx: Tx, requestId: string): Promise<void> {
  await tx.manualTimeLarkOutboxEvent.create({
    data: { requestId, kind: 'SUPERSEDE_OLD_CARDS', payload: {} },
  });
}

export async function queueManualTimeFinalizeCards(tx: Tx, requestId: string): Promise<void> {
  await tx.manualTimeLarkOutboxEvent.create({
    data: { requestId, kind: 'FINALIZE_CARDS', payload: {} },
  });
}

function retryDelayMs(attempts: number): number {
  return Math.min(15 * 60 * 1000, Math.max(1000, 1000 * 2 ** Math.min(attempts, 8)));
}

function truncateError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.slice(0, 1000);
}

async function loadRequest(requestId: string) {
  return prisma.manualTimeRequest.findUnique({
    where: { id: requestId },
    include: {
      user: { select: { name: true, workspace: { select: { timezone: true } } }, },
      approver: { select: { name: true } },
    },
  });
}

async function handleSendCard(event: { id: string; requestId: string; messageLedgerId: string | null; payload: Prisma.JsonValue }): Promise<void> {
  const messenger = getLarkMessenger();
  if (!messenger) throw new Error('lark_not_configured');
  if (!event.messageLedgerId) throw new Error('missing_message_ledger');

  const [message, req] = await Promise.all([
    prisma.manualTimeLarkMessage.findUnique({ where: { id: event.messageLedgerId } }),
    loadRequest(event.requestId),
  ]);
  if (!message) throw new Error('message_ledger_not_found');
  if (!req) throw new Error('manual_time_request_not_found');

  if (message.kind !== 'DECIDED_NOTICE' && (req.status !== 'PENDING' || message.version !== req.version)) {
    await prisma.manualTimeLarkMessage.update({
      where: { id: message.id },
      data: {
        status: req.status === 'CANCELLED' ? 'CANCELLED' : req.status === 'PENDING' ? 'SUPERSEDED' : 'DECIDED',
        lastError: null,
      },
    });
    return;
  }

  const common = {
    requestId: req.id,
    cardId: message.id,
    version: message.version,
    requesterName: req.user.name,
    taskSummary: req.taskSummary,
    startedAt: req.requestedStart.getTime(),
    endedAt: req.requestedEnd.getTime(),
    reason: req.reason,
    timeZone: req.user.workspace.timezone,
  };
  const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? (event.payload as Record<string, unknown>)
    : {};
  const diff = Array.isArray(payload.diff) ? (payload.diff as DiffEntry[]) : [];
  const card =
    message.kind === 'DECIDED_NOTICE'
      ? req.status === 'CANCELLED'
        ? buildCancelledCard({ ...common, cancelledAt: (req.decidedAt ?? new Date()).getTime() })
        : buildDecidedCard({
            ...common,
            decision: req.status === 'REJECTED' ? 'REJECTED' : 'APPROVED',
            decidedByName: req.approver?.name ?? 'Approver',
            decidedAt: (req.decidedAt ?? new Date()).getTime(),
          })
      : message.kind === 'UPDATED_APPROVAL'
        ? buildUpdatedApprovalCard({ ...common, diff })
        : buildApprovalCard(common);

  try {
    const { messageId } = await messenger.sendCard(message.recipientOpenId, card);
    await prisma.$transaction(async (tx) => {
      await tx.manualTimeLarkMessage.update({
        where: { id: message.id },
        data: {
          messageId,
          status: 'SENT',
          attempts: { increment: 1 },
          lastError: null,
          sentAt: new Date(),
        },
      });
      if (message.kind !== 'DECIDED_NOTICE' && message.version === req.version) {
        await tx.manualTimeRequest.update({
          where: { id: req.id },
          data: { larkMessageId: messageId },
        });
      }
    });
  } catch (err) {
    await prisma.manualTimeLarkMessage.update({
      where: { id: message.id },
      data: {
        status: 'SEND_FAILED',
        attempts: { increment: 1 },
        lastError: truncateError(err),
      },
    });
    throw err;
  }
}

async function handleSupersedeOldCards(event: { requestId: string }): Promise<void> {
  const messenger = getLarkMessenger();
  if (!messenger) throw new Error('lark_not_configured');
  const req = await prisma.manualTimeRequest.findUnique({ where: { id: event.requestId }, select: { id: true, version: true } });
  if (!req) throw new Error('manual_time_request_not_found');

  const hasLatestSent = await prisma.manualTimeLarkMessage.count({
    where: { requestId: req.id, version: req.version, status: 'SENT', messageId: { not: null } },
  });
  if (hasLatestSent === 0) throw new Error('latest_lark_card_not_sent_yet');

  const messages = await prisma.manualTimeLarkMessage.findMany({
    where: {
      requestId: req.id,
      version: { lt: req.version },
      messageId: { not: null },
      status: { in: ['SENT', 'SEND_FAILED', 'UPDATE_FAILED', 'STALE'] },
    },
    orderBy: { createdAt: 'asc' },
  });

  for (const message of messages) {
    try {
      await messenger.updateCard(
        message.messageId!,
        buildStaleRequestCard({ requestId: req.id, version: message.version, currentVersion: req.version }),
      );
      await prisma.manualTimeLarkMessage.update({
        where: { id: message.id },
        data: { status: 'SUPERSEDED', lastError: null },
      });
    } catch (err) {
      await prisma.manualTimeLarkMessage.update({
        where: { id: message.id },
        data: { status: 'UPDATE_FAILED', attempts: { increment: 1 }, lastError: truncateError(err) },
      });
      throw err;
    }
  }
}

async function handleFinalizeCards(event: { requestId: string }): Promise<void> {
  const messenger = getLarkMessenger();
  if (!messenger) throw new Error('lark_not_configured');
  const req = await loadRequest(event.requestId);
  if (!req) throw new Error('manual_time_request_not_found');

  const messages = await prisma.manualTimeLarkMessage.findMany({
    where: {
      requestId: req.id,
      messageId: { not: null },
      kind: { in: ['APPROVAL', 'UPDATED_APPROVAL'] },
      status: { notIn: ['CANCELLED', 'DECIDED'] },
    },
    orderBy: { createdAt: 'asc' },
  });

  const common = {
    requestId: req.id,
    requesterName: req.user.name,
    taskSummary: req.taskSummary,
    startedAt: req.requestedStart.getTime(),
    endedAt: req.requestedEnd.getTime(),
    reason: req.reason,
    timeZone: req.user.workspace.timezone,
  };
  const card =
    req.status === 'CANCELLED'
      ? buildCancelledCard({ ...common, cancelledAt: (req.decidedAt ?? new Date()).getTime() })
      : buildDecidedCard({
          ...common,
          decision: req.status === 'REJECTED' ? 'REJECTED' : 'APPROVED',
          decidedByName: req.approver?.name ?? 'Approver',
          decidedAt: (req.decidedAt ?? new Date()).getTime(),
        });
  const nextStatus = req.status === 'CANCELLED' ? 'CANCELLED' : 'DECIDED';

  for (const message of messages) {
    try {
      await messenger.updateCard(message.messageId!, card);
      await prisma.manualTimeLarkMessage.update({
        where: { id: message.id },
        data: { status: nextStatus, lastError: null },
      });
    } catch (err) {
      await prisma.manualTimeLarkMessage.update({
        where: { id: message.id },
        data: { status: 'UPDATE_FAILED', attempts: { increment: 1 }, lastError: truncateError(err) },
      });
      throw err;
    }
  }
}

async function handleEvent(event: {
  id: string;
  requestId: string;
  messageLedgerId: string | null;
  kind: OutboxKind;
  payload: Prisma.JsonValue;
}): Promise<void> {
  if (event.kind === 'SEND_CARD') return handleSendCard(event);
  if (event.kind === 'SUPERSEDE_OLD_CARDS') return handleSupersedeOldCards(event);
  return handleFinalizeCards(event);
}

export async function processManualTimeLarkOutboxOnce(limit = 10): Promise<number> {
  const now = new Date();
  const workerId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const due = await prisma.manualTimeLarkOutboxEvent.findMany({
    where: { status: 'PENDING', nextRunAt: { lte: now } },
    orderBy: [{ nextRunAt: 'asc' }, { createdAt: 'asc' }],
    take: limit,
  });
  let processed = 0;
  for (const event of due) {
    const claimed = await prisma.manualTimeLarkOutboxEvent.updateMany({
      where: { id: event.id, status: 'PENDING' },
      data: { status: 'PROCESSING', lockedAt: new Date(), lockedBy: workerId },
    });
    if (claimed.count !== 1) continue;

    try {
      await handleEvent(event);
      await prisma.manualTimeLarkOutboxEvent.update({
        where: { id: event.id },
        data: { status: 'DONE', processedAt: new Date(), lastError: null },
      });
      processed += 1;
    } catch (err) {
      const attempts = event.attempts + 1;
      const failed = attempts >= 25;
      await prisma.manualTimeLarkOutboxEvent.update({
        where: { id: event.id },
        data: {
          status: failed ? 'FAILED' : 'PENDING',
          attempts,
          nextRunAt: new Date(Date.now() + retryDelayMs(attempts)),
          lockedAt: null,
          lockedBy: null,
          lastError: truncateError(err),
        },
      });
      logger.warn({ err: truncateError(err), eventId: event.id, kind: event.kind, attempts }, 'manual time Lark outbox event failed');
    }
  }
  return processed;
}

let timer: NodeJS.Timeout | null = null;

export function startManualTimeLarkOutboxWorker(intervalMs = 5000): void {
  if (timer || process.env.NODE_ENV === 'test') return;
  timer = setInterval(() => {
    processManualTimeLarkOutboxOnce().catch((err) => {
      logger.error({ err: String(err) }, 'manual time Lark outbox worker crashed');
    });
  }, intervalMs);
  timer.unref?.();
}
