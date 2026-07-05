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
      const errorText = redactText(err instanceof Error ? err.message : String(err));
      let fallback: { messageId: string } | null = null;
      if (event.kind === 'SEND_CARD' && isCardRenderError(errorText)) {
        try {
          fallback = await sendCardFallback(messenger, event, event.payload);
        } catch {
          fallback = null;
        }
      }
      if (fallback) {
        await prisma.testerOpsOutboxEvent.update({
          where: { id: event.id },
          data: {
            status: 'DONE',
            attempts: { increment: 1 },
            messageId: fallback.messageId,
            processedAt: new Date(),
            lastError: `rich_card_fallback: ${errorText}`,
          },
        });
        processed += 1;
        continue;
      }

      const attempts = event.attempts + 1;
      await prisma.testerOpsOutboxEvent.update({
        where: { id: event.id },
        data: {
          status: attempts >= 10 ? 'DEAD_LETTER' : 'FAILED',
          attempts,
          lastError: errorText,
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

async function sendCardFallback(
  messenger: NonNullable<ReturnType<typeof getTesterOpsLarkMessenger>>,
  event: TesterOpsOutboxEvent,
  rawPayload: TesterOpsOutboxEvent['payload'],
) {
  const payload = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
    ? (rawPayload as { card?: unknown })
    : {};
  if (!payload.card || typeof payload.card !== 'object' || Array.isArray(payload.card)) return null;
  const text = cardFallbackText(payload.card as Record<string, unknown>);
  if (!text) return null;
  return event.chatId
    ? messenger.sendTextToChat(event.chatId, text, `${event.idempotencyKey}:fallback`)
    : event.openId
      ? messenger.sendText(event.openId, text)
      : null;
}

function isCardRenderError(errorText: string): boolean {
  return errorText.includes('200621')
    || errorText.includes('Failed to create card content')
    || errorText.includes('parse card json err');
}

function cardFallbackText(card: Record<string, unknown>): string {
  const title = readCardString(card, ['header', 'title', 'content']);
  const markdown = collectMarkdown(card).join('\n\n');
  return plainFallbackText([title, markdown].filter(Boolean).join('\n\n'), 1900);
}

function collectMarkdown(value: unknown): string[] {
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  const here = record.tag === 'markdown' && typeof record.content === 'string' ? [record.content] : [];
  const children = Object.values(record).flatMap((child) => {
    if (Array.isArray(child)) return child.flatMap(collectMarkdown);
    return collectMarkdown(child);
  });
  return [...here, ...children];
}

function readCardString(card: Record<string, unknown>, path: string[]): string | null {
  let current: unknown = card;
  for (const part of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return null;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : null;
}

function plainFallbackText(value: string, max: number): string {
  const plain = value
    .replace(/&#60;/gu, '<')
    .replace(/&#62;/gu, '>')
    .replace(/&amp;/gu, '&')
    .replace(/^#{1,6}\s*/gmu, '')
    .replace(/\*\*/gu, '')
    .replace(/`/gu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
  if (plain.length <= max) return plain;
  return `${plain.slice(0, max - 1).trimEnd()}...`;
}

function retryDelayMs(attempts: number): number {
  return Math.min(15 * 60 * 1000, 1000 * 2 ** Math.min(attempts, 8));
}
