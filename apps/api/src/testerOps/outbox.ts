import { randomUUID } from 'node:crypto';
import { prisma, type Prisma, type TesterOpsOutboxEvent } from '@grind/db';
import { redactJson, redactText } from './redact';
import { getTesterOpsLarkMessenger } from './larkRuntime';

type Tx = Prisma.TransactionClient;

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

/**
 * Outbox row lifecycle
 *
 *   PENDING      queued, never tried.
 *   PROCESSING   claimed by one worker (lockedAt/lockedBy set). A worker that
 *                dies mid-send leaves the row here; once lockedAt is older
 *                than STALE_LOCK_MS any worker may reclaim it.
 *   DONE         delivered (or delivered via the plain-text fallback).
 *   FAILED       RETRYABLE. The last attempt failed with something that may
 *                pass next time (network, Lark 5xx, rate limit); retried at
 *                nextRunAt with exponential backoff.
 *   DEAD_LETTER  TERMINAL. Either MAX_ATTEMPTS were spent, or the row can
 *                never succeed (no recipient, malformed payload). Never
 *                retried automatically; lastError says why.
 *
 * `attempts` counts claims, so a row whose worker keeps crashing still runs
 * out of attempts instead of looping forever.
 */
const TESTER_OPS_OUTBOX_MAX_ATTEMPTS = 10;
const STALE_LOCK_MS = 5 * 60_000;
const TERMINAL_ERRORS = new Set(['missing_lark_recipient', 'missing_text_payload', 'missing_card_payload']);

export async function processTesterOpsOutbox(limit = 10): Promise<number> {
  const messenger = getTesterOpsLarkMessenger();
  if (!messenger) return 0;
  const workerId = `tester-ops-${process.pid}-${randomUUID()}`;
  const now = new Date();
  const due = await prisma.testerOpsOutboxEvent.findMany({
    where: {
      OR: [
        { status: { in: ['PENDING', 'FAILED'] }, nextRunAt: { lte: now } },
        { status: 'PROCESSING', lockedAt: { lt: new Date(now.getTime() - STALE_LOCK_MS) } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
  });
  let processed = 0;
  for (const candidate of due) {
    // Conditional on the exact state we read, so two workers (or a worker and
    // a stale-lock reclaim) can never both win the same row.
    const claimed = await prisma.testerOpsOutboxEvent.updateMany({
      where: {
        id: candidate.id,
        status: candidate.status,
        ...(candidate.status === 'PROCESSING' ? { lockedAt: candidate.lockedAt } : {}),
      },
      data: { status: 'PROCESSING', lockedAt: new Date(), lockedBy: workerId, attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) continue;
    const event = { ...candidate, attempts: candidate.attempts + 1 };
    if (candidate.status === 'PROCESSING' && event.attempts > TESTER_OPS_OUTBOX_MAX_ATTEMPTS) {
      await prisma.testerOpsOutboxEvent.update({
        where: { id: event.id },
        data: { status: 'DEAD_LETTER', lastError: candidate.lastError ?? 'stale_lock_attempts_exhausted', lockedAt: null, lockedBy: null },
      });
      continue;
    }
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
          messageId: result.messageId,
          processedAt: new Date(),
          lastError: null,
          lockedAt: null,
          lockedBy: null,
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
            messageId: fallback.messageId,
            processedAt: new Date(),
            lastError: `rich_card_fallback: ${errorText}`,
            lockedAt: null,
            lockedBy: null,
          },
        });
        processed += 1;
        continue;
      }

      const terminal = TERMINAL_ERRORS.has(errorText) || event.attempts >= TESTER_OPS_OUTBOX_MAX_ATTEMPTS;
      await prisma.testerOpsOutboxEvent.update({
        where: { id: event.id },
        data: {
          status: terminal ? 'DEAD_LETTER' : 'FAILED',
          lastError: errorText,
          nextRunAt: new Date(Date.now() + retryDelayMs(event.attempts)),
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
