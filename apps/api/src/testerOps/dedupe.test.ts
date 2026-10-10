import { afterEach, describe, expect, it } from 'vitest';
import { prisma, type Prisma } from '@grind/db';
import type { LarkMessenger, SendCardResult } from '../lark';
import type { ListChatMessagesResult } from '../lark/messenger';
import { env } from '../env';
import { setTesterOpsAiClientForTests, type TesterOpsAiClient } from './ai/brain';
import { ingestHistoryMessage, ingestRawLarkMessage, processTesterEvent } from './inbound';
import { setTesterOpsLarkMessengerForTests } from './larkRuntime';
import { processTesterOpsOutbox } from './outbox';
import { pollHistory, runTesterOpsMaintenance, TESTER_OPS_RETENTION_MS } from './scheduler';

const CHAT = 'oc_configured_status';

class FakeMessenger implements LarkMessenger {
  chatCards: Array<{ chatId: string; idempotencyKey?: string }> = [];
  updates: string[] = [];
  pages: ListChatMessagesResult[] = [];
  listCalls: Array<{ start?: Date; pageToken?: string | null }> = [];
  failSend: string | null = null;

  async sendText(): Promise<SendCardResult> {
    return { messageId: 'text' };
  }
  async sendTextToChat(): Promise<SendCardResult> {
    return { messageId: 'chat-text' };
  }
  async sendCard(): Promise<SendCardResult> {
    return { messageId: 'card' };
  }
  async sendCardToChat(chatId: string, _card: Record<string, unknown>, idempotencyKey?: string): Promise<SendCardResult> {
    if (this.failSend) throw new Error(this.failSend);
    this.chatCards.push({ chatId, idempotencyKey });
    return { messageId: `chat-card-${this.chatCards.length}` };
  }
  async updateCard(messageId: string): Promise<void> {
    this.updates.push(messageId);
  }
  async listChatMessages(args: { start?: Date; pageToken?: string | null }): Promise<ListChatMessagesResult> {
    this.listCalls.push({ start: args.start, pageToken: args.pageToken });
    return this.pages.shift() ?? { messages: [], hasMore: false, pageToken: null };
  }
}

function countingAi(): TesterOpsAiClient & { calls: number } {
  const ai = {
    calls: 0,
    async decideMessage() {
      ai.calls += 1;
      // Hold the claim long enough for a racing duplicate to arrive.
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        aiRunId: 'fake-run',
        decision: {
          intent: 'USAGE_STATUS' as const,
          confidence: 0.94,
          language: 'english',
          category: 'status',
          severity: 'LOW' as const,
          summary: 'status',
          safeAction: 'GET_USAGE_STATUS' as const,
          replyText: 'status',
          needsClarification: false,
          clarifyingQuestion: null,
          citations: [],
        },
      };
    },
    async answerDocs() {
      return { aiRunId: 'doc', answer: { confidence: 0, answer: null, missingInfo: 'n/a', refusalReason: null, citations: [] } };
    },
    async answerGeneral() {
      return { aiRunId: 'gen', answer: { confidence: 0.9, answer: 'hi', citations: [] } };
    },
  };
  return ai;
}

afterEach(() => {
  setTesterOpsAiClientForTests(null);
  setTesterOpsLarkMessengerForTests(null);
});

async function seedWorkspace() {
  await prisma.workspace.create({ data: { id: env.WORKSPACE_ID, name: 'Tester Ops Dedupe' } });
}

function larkEvent(eventId: string, messageId: string) {
  return {
    event_id: eventId,
    event: {
      sender: { sender_type: 'user', sender_id: { open_id: 'ou_tester' } },
      message: {
        message_id: messageId,
        chat_id: CHAT,
        chat_type: 'group',
        mentions: [{ key: '@_user_1', name: 'Timo' }],
        body: { content: JSON.stringify({ text: '@_user_1 status' }) },
      },
    },
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 3000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for predicate');
}

async function settled() {
  // Let any fire-and-forget processing finish before asserting "only once".
  await waitFor(async () => (await prisma.testerOpsEvent.count({ where: { status: { in: ['PENDING', 'PROCESSING'] } } })) === 0);
  await new Promise((resolve) => setTimeout(resolve, 150));
}

describe('tester ops: one Lark message is answered once', () => {
  it('dedupes the websocket event and the history poll copy of the same message', async () => {
    const messenger = new FakeMessenger();
    const ai = countingAi();
    setTesterOpsLarkMessengerForTests(messenger);
    setTesterOpsAiClientForTests(ai);
    await seedWorkspace();

    await ingestRawLarkMessage(larkEvent('ev-1', 'om-1'));
    await ingestHistoryMessage({ chatId: CHAT, messageId: 'om-1', senderOpenId: 'ou_tester', messageText: '@Timo status', createTimeMs: Date.now() });
    await settled();

    expect(await prisma.testerOpsEvent.count()).toBe(1);
    expect(ai.calls).toBe(1);
    expect(messenger.chatCards.filter((c) => c.idempotencyKey?.startsWith('tester-ops-thinking'))).toHaveLength(1);
  });

  it('answers once when both paths race', async () => {
    const messenger = new FakeMessenger();
    const ai = countingAi();
    setTesterOpsLarkMessengerForTests(messenger);
    setTesterOpsAiClientForTests(ai);
    await seedWorkspace();

    await Promise.all([
      ingestRawLarkMessage(larkEvent('ev-race', 'om-race')),
      ingestHistoryMessage({ chatId: CHAT, messageId: 'om-race', senderOpenId: 'ou_tester', messageText: '@Timo status', createTimeMs: Date.now() }),
      ingestRawLarkMessage(larkEvent('ev-race', 'om-race')), // Lark redelivery
    ]);
    await settled();

    expect(await prisma.testerOpsEvent.count()).toBe(1);
    expect(ai.calls).toBe(1);
  });

  it('claims before processing: a second processTesterEvent on the same row is skipped', async () => {
    setTesterOpsLarkMessengerForTests(new FakeMessenger());
    const ai = countingAi();
    setTesterOpsAiClientForTests(ai);
    await seedWorkspace();
    const event = await prisma.testerOpsEvent.create({
      data: { workspaceId: env.WORKSPACE_ID, source: 'MANUAL_REPLAY', sourceId: 'r-1', messageText: '@Timo status', chatId: CHAT },
    });

    const [a, b] = await Promise.all([processTesterEvent(event.id), processTesterEvent(event.id)]);
    expect(ai.calls).toBe(1);
    expect([a, b].filter((r) => 'skipped' in r)).toHaveLength(1);
    expect((await prisma.testerOpsEvent.findUniqueOrThrow({ where: { id: event.id } })).status).toBe('PROCESSED');
  });

  it('marks the event FAILED (not stuck PROCESSING) when processing throws', async () => {
    setTesterOpsLarkMessengerForTests(new FakeMessenger());
    setTesterOpsAiClientForTests({
      ...countingAi(),
      async decideMessage() {
        throw new Error('provider down');
      },
    });
    await seedWorkspace();
    const event = await prisma.testerOpsEvent.create({
      data: { workspaceId: env.WORKSPACE_ID, source: 'MANUAL_REPLAY', sourceId: 'r-2', messageText: '@Timo status', chatId: CHAT },
    });

    await expect(processTesterEvent(event.id)).rejects.toThrow('provider down');
    const row = await prisma.testerOpsEvent.findUniqueOrThrow({ where: { id: event.id } });
    expect(row.status).toBe('FAILED');
    expect(row.error).toContain('provider down');
  });
});

describe('tester ops: history poll', () => {
  it('reads every page and resumes from the newest handled createTime, not wall-clock now', async () => {
    const messenger = new FakeMessenger();
    setTesterOpsLarkMessengerForTests(messenger);
    setTesterOpsAiClientForTests(countingAi());
    await seedWorkspace();
    const base = Date.now() - 60 * 60_000;
    const msg = (i: number) => ({
      messageId: `om-page-${i}`,
      chatId: CHAT,
      senderOpenId: 'ou_tester',
      messageType: 'text',
      content: `@Timo message ${i}`,
      createTimeMs: base + i * 1000,
    });
    messenger.pages = [
      { messages: [msg(1), msg(2)], hasMore: true, pageToken: 'p2' },
      { messages: [msg(3)], hasMore: true, pageToken: 'p3' },
      { messages: [msg(4)], hasMore: false, pageToken: null },
    ];

    await pollHistory(env.WORKSPACE_ID, CHAT, new Date(base), true);
    await settled();

    expect(messenger.listCalls.map((c) => c.pageToken ?? null)).toEqual([null, 'p2', 'p3']);
    expect(await prisma.testerOpsEvent.count({ where: { source: 'HISTORY_POLL' } })).toBe(4);
    const cfg = await prisma.testerOpsConfig.findUniqueOrThrow({ where: { workspaceId: env.WORKSPACE_ID } });
    expect(cfg.lastHistoryPollAt?.getTime()).toBe(base + 4000);

    // Next tick starts at that createTime; the overlapping message is deduped.
    messenger.pages = [{ messages: [msg(4)], hasMore: false, pageToken: null }];
    await pollHistory(env.WORKSPACE_ID, CHAT, cfg.lastHistoryPollAt, true);
    await settled();
    expect(messenger.listCalls.at(-1)?.start?.getTime()).toBe(base + 4000);
    expect(await prisma.testerOpsEvent.count({ where: { source: 'HISTORY_POLL' } })).toBe(4);
  });

  it('keeps the resume point when nothing new arrived', async () => {
    const messenger = new FakeMessenger();
    setTesterOpsLarkMessengerForTests(messenger);
    await seedWorkspace();
    await prisma.testerOpsConfig.create({ data: { workspaceId: env.WORKSPACE_ID, lastHistoryPollAt: new Date(Date.now() - 30 * 60_000) } });
    const before = await prisma.testerOpsConfig.findUniqueOrThrow({ where: { workspaceId: env.WORKSPACE_ID } });

    await pollHistory(env.WORKSPACE_ID, CHAT, before.lastHistoryPollAt, true);

    const after = await prisma.testerOpsConfig.findUniqueOrThrow({ where: { workspaceId: env.WORKSPACE_ID } });
    expect(after.lastHistoryPollAt?.getTime()).toBe(before.lastHistoryPollAt?.getTime());
  });
});

describe('tester ops: outbox', () => {
  async function seedOutbox(data: Partial<Prisma.TesterOpsOutboxEventUncheckedCreateInput> & { idempotencyKey: string }) {
    return prisma.testerOpsOutboxEvent.create({
      data: {
        workspaceId: env.WORKSPACE_ID,
        kind: 'SEND_CARD',
        chatId: CHAT,
        payload: { card: { header: { title: { content: 'x' } } } },
        ...data,
      },
    });
  }

  it('reclaims a PROCESSING row whose lock is stale, leaves a fresh lock alone', async () => {
    const messenger = new FakeMessenger();
    setTesterOpsLarkMessengerForTests(messenger);
    await seedWorkspace();
    const stale = await seedOutbox({ idempotencyKey: 'stale', status: 'PROCESSING', lockedAt: new Date(Date.now() - 10 * 60_000), lockedBy: 'dead', attempts: 1 });
    const fresh = await seedOutbox({ idempotencyKey: 'fresh', status: 'PROCESSING', lockedAt: new Date(), lockedBy: 'alive', attempts: 1 });

    expect(await processTesterOpsOutbox()).toBe(1);

    const staleRow = await prisma.testerOpsOutboxEvent.findUniqueOrThrow({ where: { id: stale.id } });
    expect(staleRow.status).toBe('DONE');
    expect(staleRow.attempts).toBe(2);
    const freshRow = await prisma.testerOpsOutboxEvent.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(freshRow.status).toBe('PROCESSING');
    expect(freshRow.lockedBy).toBe('alive');
  });

  it('FAILED is retryable; an unfixable row goes straight to DEAD_LETTER', async () => {
    const messenger = new FakeMessenger();
    messenger.failSend = 'lark sendMessage: rate limited';
    setTesterOpsLarkMessengerForTests(messenger);
    await seedWorkspace();
    const retryable = await seedOutbox({ idempotencyKey: 'retryable' });
    const unfixable = await seedOutbox({ idempotencyKey: 'unfixable', chatId: null, openId: null });

    await processTesterOpsOutbox();

    const r = await prisma.testerOpsOutboxEvent.findUniqueOrThrow({ where: { id: retryable.id } });
    expect(r.status).toBe('FAILED');
    expect(r.attempts).toBe(1);
    expect(r.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    const u = await prisma.testerOpsOutboxEvent.findUniqueOrThrow({ where: { id: unfixable.id } });
    expect(u.status).toBe('DEAD_LETTER');
    expect(u.lastError).toBe('missing_lark_recipient');
  });
});

describe('tester ops: maintenance', () => {
  it('prunes audit rows past retention and closes abandoned claims', async () => {
    await seedWorkspace();
    const old = new Date(Date.now() - TESTER_OPS_RETENTION_MS - 24 * 60 * 60_000);
    const ws = env.WORKSPACE_ID;
    const oldEvent = await prisma.testerOpsEvent.create({
      data: { workspaceId: ws, source: 'MANUAL_REPLAY', sourceId: 'old', messageText: 'old', status: 'PROCESSED', receivedAt: old },
    });
    const issue = await prisma.testerOpsIssue.create({ data: { workspaceId: ws, eventId: oldEvent.id, summary: 'kept' } });
    await prisma.testerOpsEvent.create({ data: { workspaceId: ws, source: 'MANUAL_REPLAY', sourceId: 'new', messageText: 'new', status: 'PROCESSED' } });
    await prisma.testerOpsAiRun.create({ data: { workspaceId: ws, provider: 'x', model: 'x', promptVersion: 'x', task: 'x', input: {}, createdAt: old } });
    await prisma.testerOpsAiRun.create({ data: { workspaceId: ws, provider: 'x', model: 'x', promptVersion: 'x', task: 'x', input: {} } });
    await prisma.testerOpsOutboxEvent.create({ data: { workspaceId: ws, kind: 'SEND_CARD', idempotencyKey: 'old-done', status: 'DONE', createdAt: old } });
    await prisma.testerOpsOutboxEvent.create({ data: { workspaceId: ws, kind: 'SEND_CARD', idempotencyKey: 'old-dead', status: 'DEAD_LETTER', createdAt: old } });
    const stuck = await prisma.testerOpsEvent.create({
      data: { workspaceId: ws, source: 'MANUAL_REPLAY', sourceId: 'stuck', messageText: 'stuck', status: 'PROCESSING' },
    });
    // An explicit value overrides @updatedAt: backdate the claim by an hour.
    await prisma.testerOpsEvent.update({ where: { id: stuck.id }, data: { updatedAt: new Date(Date.now() - 60 * 60_000) } });

    const result = await runTesterOpsMaintenance();

    expect(result.abandoned).toBe(1);
    expect(result.pruned).toEqual({ events: 1, aiRuns: 1, outbox: 1 });
    expect((await prisma.testerOpsEvent.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe('FAILED');
    expect(await prisma.testerOpsEvent.count()).toBe(2);
    expect((await prisma.testerOpsIssue.findUniqueOrThrow({ where: { id: issue.id } })).eventId).toBeNull();
    expect(await prisma.testerOpsOutboxEvent.count()).toBe(1);
  });
});
