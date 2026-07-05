import { randomUUID } from 'node:crypto';
import { prisma, type Prisma, type TesterOpsOutboxEvent } from '@grind/db';
import { redactJson, redactText } from './redact';
import { getTesterOpsLarkMessenger } from './larkRuntime';

type Tx = Prisma.TransactionClient;

export async function enqueueTesterOpsText(
  tx: Tx,
  args: { workspaceId: string; chatId?: string | null; openId?: string | null; text: string; idempotencyKey: string },
) {
  await tx.testerOpsOutboxEvent.upsert({
    where: { idempotencyKey: args.idempotencyKey },
    update: {},
    create: {
      workspaceId: args.workspaceId,
      kind: 'SEND_TEXT',
      idempotencyKey: args.idempotencyKey,
      chatId: args.chatId ?? null,
      openId: args.openId ?? null,
      payload: { text: redactText(args.text) },
    },
  });
}

export async function enqueueTesterOpsCard(
  tx: Tx,
  args: { workspaceId: string; chatId?: string | null; openId?: string | null; card: Record<string, unknown>; idempotencyKey: string },
) {
  await tx.testerOpsOutboxEvent.upsert({
    where: { idempotencyKey: args.idempotencyKey },
    update: {},
    create: {
      workspaceId: args.workspaceId,
      kind: 'SEND_CARD',
      idempotencyKey: args.idempotencyKey,
      chatId: args.chatId ?? null,
      openId: args.openId ?? null,
      payload: redactJson({ card: args.card }) as Prisma.InputJsonValue,
    },
  });
}

export async function processTesterOpsOutbox(limit = 10): Promise<number> {
  const messenger = getTesterOpsLarkMessenger();
  if (!messenger) return 0;
  const workerId = `tester-ops-${process.pid}-${randomUUID()}`;
  const due = await prisma.testerOpsOutboxEvent.findMany({
    where: { status: { in: ['PENDING', 'FAILED'] }, nextRunAt: { lte: new Date() } },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  let processed = 0;
  for (const event of due) {
    const claimed = await prisma.testerOpsOutboxEvent.updateMany({
      where: { id: event.id, status: event.status },
      data: { status: 'PROCESSING', lockedAt: new Date(), lockedBy: workerId },
    });
    if (claimed.count !== 1) continue;
    try {
      const payload = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? (event.payload as { text?: unknown; card?: unknown })
        : {};
      const result = event.kind === 'SEND_CARD'
        ? await sendCardPayload(messenger, event, payload)
        : await sendTextPayload(messenger, event, payload);
      if (!result) throw new Error('missing_lark_recipient');
      await prisma.testerOpsOutboxEvent.update({
        where: { id: event.id },
        data: {
          status: 'DONE',
          attempts: { increment: 1 },
          messageId: result.messageId,
          processedAt: new Date(),
          lastError: null,
        },
      });
      processed += 1;
    } catch (err) {
      const attempts = event.attempts + 1;
      await prisma.testerOpsOutboxEvent.update({
        where: { id: event.id },
        data: {
          status: attempts >= 10 ? 'DEAD_LETTER' : 'FAILED',
          attempts,
          lastError: redactText(err instanceof Error ? err.message : String(err)),
          nextRunAt: new Date(Date.now() + retryDelayMs(attempts)),
          lockedAt: null,
          lockedBy: null,
        },
      });
    }
  }
  return processed;
}

async function sendTextPayload(
  messenger: NonNullable<ReturnType<typeof getTesterOpsLarkMessenger>>,
  event: TesterOpsOutboxEvent,
  payload: { text?: unknown },
) {
  const text = typeof payload.text === 'string' ? payload.text : '';
  if (!text) throw new Error('missing_text_payload');
  return event.chatId
    ? messenger.sendTextToChat(event.chatId, text, event.idempotencyKey)
    : event.openId
      ? messenger.sendText(event.openId, text)
      : null;
}

async function sendCardPayload(
  messenger: NonNullable<ReturnType<typeof getTesterOpsLarkMessenger>>,
  event: TesterOpsOutboxEvent,
  payload: { card?: unknown },
) {
  if (!payload.card || typeof payload.card !== 'object' || Array.isArray(payload.card)) throw new Error('missing_card_payload');
  const card = payload.card as Record<string, unknown>;
  return event.chatId
    ? messenger.sendCardToChat(event.chatId, card, event.idempotencyKey)
    : event.openId
      ? messenger.sendCard(event.openId, card)
      : null;
}

function retryDelayMs(attempts: number): number {
  return Math.min(15 * 60 * 1000, 1000 * 2 ** Math.min(attempts, 8));
}
