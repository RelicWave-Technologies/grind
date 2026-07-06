import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '@grind/db';
import type { LarkMessenger, SendCardResult } from '../lark';
import { env } from '../env';
import { setTesterOpsAiClientForTests, type TesterOpsAiClient } from './ai/brain';
import { ingestRawLarkMessage } from './inbound';
import { setTesterOpsLarkMessengerForTests } from './larkRuntime';

class FakeMessenger implements LarkMessenger {
  chatCards: Array<{ chatId: string; card: Record<string, unknown>; idempotencyKey?: string }> = [];
  updates: Array<{ messageId: string; card: Record<string, unknown> }> = [];

  async sendText(): Promise<SendCardResult> {
    return { messageId: 'unused-text' };
  }

  async sendTextToChat(): Promise<SendCardResult> {
    return { messageId: 'unused-chat-text' };
  }

  async sendCard(): Promise<SendCardResult> {
    return { messageId: 'unused-card' };
  }

  async sendCardToChat(chatId: string, card: Record<string, unknown>, idempotencyKey?: string): Promise<SendCardResult> {
    this.chatCards.push({ chatId, card, idempotencyKey });
    return { messageId: `chat-card-${this.chatCards.length}` };
  }

  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    this.updates.push({ messageId, card });
  }
}

const fakeAi: TesterOpsAiClient = {
  async decideMessage() {
    return {
      aiRunId: 'fake-run',
      decision: {
        intent: 'USAGE_STATUS',
        confidence: 0.94,
        language: 'english',
        category: 'status',
        severity: 'LOW',
        summary: 'User asked for tester status.',
        safeAction: 'GET_USAGE_STATUS',
        replyText: 'Here is the current tester status.',
        needsClarification: false,
        clarifyingQuestion: null,
        citations: [],
      },
    };
  },
  async answerDocs() {
    return {
      aiRunId: 'unused-doc-run',
      answer: {
        confidence: 0,
        answer: null,
        missingInfo: 'No doc lookup in this test.',
        refusalReason: null,
        citations: [],
      },
    };
  },
  async answerGeneral() {
    return {
      aiRunId: 'unused-general-run',
      answer: {
        confidence: 0.9,
        answer: 'I am Timo, your Grind testing assistant.',
        citations: [],
      },
    };
  },
};

afterEach(() => {
  setTesterOpsAiClientForTests(null);
  setTesterOpsLarkMessengerForTests(null);
});

describe('tester ops inbound chat routing', () => {
  it('replies in any Lark chat when Timo is directly mentioned', async () => {
    const messenger = new FakeMessenger();
    setTesterOpsLarkMessengerForTests(messenger);
    setTesterOpsAiClientForTests(fakeAi);
    await seedWorkspace();

    await ingestRawLarkMessage(larkTextEvent({
      eventId: 'ev-any-chat-mention',
      chatId: 'oc_random_group',
      messageId: 'om-any-chat-mention',
      text: '@_user_1 status',
      mentions: [{ key: '@_user_1', name: 'Timo' }],
    }));

    await waitFor(async () => messenger.updates.length > 0);
    expect(messenger.chatCards[0]?.chatId).toBe('oc_random_group');
    expect(messenger.chatCards[0]?.idempotencyKey).toContain('tester-ops-thinking');
    expect(messenger.updates[0]?.messageId).toBe('chat-card-1');

    const event = await prisma.testerOpsEvent.findUnique({
      where: { workspaceId_source_sourceId: { workspaceId: env.WORKSPACE_ID, source: 'LARK_EVENT', sourceId: 'ev-any-chat-mention' } },
    });
    expect(event?.chatId).toBe('oc_random_group');
    expect(event?.status).toBe('PROCESSED');
  });

  it('does not passively monitor unrelated chats without a direct mention', async () => {
    const messenger = new FakeMessenger();
    setTesterOpsLarkMessengerForTests(messenger);
    setTesterOpsAiClientForTests(fakeAi);
    await seedWorkspace();

    await ingestRawLarkMessage(larkTextEvent({
      eventId: 'ev-unmentioned-other-chat',
      chatId: 'oc_random_group',
      messageId: 'om-unmentioned-other-chat',
      text: 'screenshots are not uploading',
    }));

    const count = await prisma.testerOpsEvent.count({ where: { workspaceId: env.WORKSPACE_ID } });
    expect(count).toBe(0);
    expect(messenger.chatCards).toHaveLength(0);
  });

  it('answers Timo identity/help mentions without requiring docs', async () => {
    const messenger = new FakeMessenger();
    setTesterOpsLarkMessengerForTests(messenger);
    setTesterOpsAiClientForTests({
      ...fakeAi,
      async decideMessage() {
        return {
          aiRunId: 'fake-general-decision-run',
          decision: {
            intent: 'GENERAL_HELP',
            confidence: 0.95,
            language: 'english',
            category: 'help',
            severity: 'LOW',
            summary: 'User asked who Timo is.',
            safeAction: 'ANSWER_GENERAL',
            replyText: null,
            needsClarification: false,
            clarifyingQuestion: null,
            citations: [],
          },
        };
      },
    });
    await seedWorkspace();

    await ingestRawLarkMessage(larkTextEvent({
      eventId: 'ev-who-are-you',
      chatId: 'oc_random_group',
      messageId: 'om-who-are-you',
      text: '@_user_1 who are you',
      mentions: [{ key: '@_user_1', name: 'Timo' }],
    }));

    await waitFor(async () => messenger.updates.length > 0);

    const rendered = JSON.stringify(messenger.updates[0]?.card);
    expect(rendered).toContain('I am Timo');
    expect(rendered).not.toContain('Needs docs');
    expect(rendered).not.toContain('Not enough evidence');
  });
});

async function seedWorkspace() {
  await prisma.workspace.create({ data: { id: env.WORKSPACE_ID, name: 'Tester Ops Routing' } });
}

function larkTextEvent(input: {
  eventId: string;
  chatId: string;
  messageId: string;
  text: string;
  mentions?: Array<{ key: string; name: string }>;
}) {
  return {
    event_id: input.eventId,
    event: {
      sender: {
        sender_type: 'user',
        sender_id: { open_id: 'ou_tester' },
      },
      message: {
        message_id: input.messageId,
        chat_id: input.chatId,
        mentions: input.mentions,
        body: { content: JSON.stringify({ text: input.text }) },
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
