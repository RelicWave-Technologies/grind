import { prisma, type Prisma } from '@grind/db';
import { env } from '../env';
import { logger } from '../logger';
import { getTesterOpsAiClient } from './ai/brain';
import {
  buildTesterOpsDocAnswerCard,
  buildTesterOpsGeneralCard,
  hasTesterOpsStreamingImage,
  buildTesterOpsIssueCard,
  buildTesterOpsIssueListCard,
  buildTesterOpsPingCard,
  buildTesterOpsThinkingCard,
  buildTesterOpsUsageCard,
  type TesterIssueListSnapshot,
} from './cards';
import { isDirectMention, loadOrCreateAiPolicy, loadOrCreateTesterOpsConfig } from './config';
import { retrieveKnowledgeChunks } from './knowledge';
import { getTesterOpsLarkMessenger } from './larkRuntime';
import { enqueueTesterOpsCard } from './outbox';
import { redactJson, redactText } from './redact';
import { buildTesterUsageSnapshot } from './usage';

export async function ingestRawLarkMessage(raw: unknown): Promise<void> {
  const parsed = parseLarkMessageEvent(raw);
  if (!parsed) return;
  await ingestTesterMessage({ ...parsed, source: 'LARK_EVENT' });
}

export async function ingestHistoryMessage(args: {
  workspaceId?: string;
  chatId: string;
  messageId: string;
  senderOpenId: string | null;
  messageText: string;
  createTimeMs: number;
}) {
  await ingestTesterMessage({
    workspaceId: args.workspaceId ?? env.WORKSPACE_ID,
    source: 'HISTORY_POLL',
    sourceId: args.messageId,
    chatId: args.chatId,
    messageId: args.messageId,
    senderOpenId: args.senderOpenId,
    messageText: args.messageText,
    raw: { createTimeMs: args.createTimeMs },
  });
}

export async function replayTesterMessage(args: { workspaceId: string; messageText: string; directMention?: boolean }) {
  const event = await prisma.testerOpsEvent.create({
    data: {
      workspaceId: args.workspaceId,
      source: 'MANUAL_REPLAY',
      sourceId: `replay:${Date.now()}:${Math.random().toString(36).slice(2)}`,
      messageText: args.messageText,
      status: 'PENDING',
    },
  });
  return processTesterEvent(event.id, args.directMention);
}

async function ingestTesterMessage(args: {
  workspaceId?: string;
  source: 'LARK_EVENT' | 'HISTORY_POLL';
  sourceId: string;
  chatId: string | null;
  chatType?: string | null;
  messageId: string | null;
  senderOpenId: string | null;
  senderType?: string | null;
  messageText: string;
  raw?: unknown;
}) {
  const workspaceId = args.workspaceId ?? env.WORKSPACE_ID;
  const cfg = await loadOrCreateTesterOpsConfig(workspaceId);
  if (!cfg.enabled) return;
  if (!args.chatId) return;
  if (args.senderType && args.senderType !== 'user') return;
  if (!args.senderOpenId) return;
  if (!args.messageText.trim()) return;
  const directMention = isDirectTesterMessage(args.messageText, args.chatType);
  const configuredChat = Boolean(cfg.chatId && args.chatId === cfg.chatId);
  if (!configuredChat && !directMention) return;

  const member = await prisma.testerOpsMember.upsert({
    where: { workspaceId_openId: { workspaceId, openId: args.senderOpenId } },
    update: { lastSeenAt: new Date() },
    create: { workspaceId, openId: args.senderOpenId, lastSeenAt: new Date() },
  });

  const event = await prisma.testerOpsEvent.upsert({
    where: { workspaceId_source_sourceId: { workspaceId, source: args.source, sourceId: args.sourceId } },
    update: {},
    create: {
      workspaceId,
      source: args.source,
      sourceId: args.sourceId,
      chatId: args.chatId,
      messageId: args.messageId,
      senderOpenId: args.senderOpenId,
      memberId: member?.id,
      messageText: redactText(args.messageText),
      raw: redactJson(args.raw) as Prisma.InputJsonValue,
    },
  });
  if (event.status !== 'PENDING') return;
  void processTesterEvent(event.id).catch((err) => {
    logger.error({ err: String(err), eventId: event.id }, 'tester ops event processing failed');
  });
}

export async function processTesterEvent(eventId: string, forceDirectMention?: boolean) {
  const event = await prisma.testerOpsEvent.findUnique({ where: { id: eventId }, include: { member: true } });
  if (!event) throw new Error('event_not_found');
  const cfg = await loadOrCreateTesterOpsConfig(event.workspaceId);
  const policy = await loadOrCreateAiPolicy(event.workspaceId);
  const rawChatType = event.raw && typeof event.raw === 'object'
    ? getLarkMessageChatType(event.raw)
    : null;
  const directMention = forceDirectMention ?? isDirectTesterMessage(event.messageText, rawChatType);
  const replyChatId = event.chatId ?? cfg.chatId;
  if (!directMention && !cfg.passiveIssueDetectionEnabled) {
    await prisma.testerOpsEvent.update({ where: { id: event.id }, data: { status: 'IGNORED', processedAt: new Date() } });
    return { ignored: true };
  }

  const usageSnapshot = directMention ? await buildTesterUsageSnapshot(event.workspaceId, cfg.timezone) : undefined;
  const progress = directMention && replyChatId
    ? await startProgressCard(replyChatId, event.id, event.messageText)
    : null;
  const progressMessageId = progress?.messageId ?? null;
  try {
    const ai = getTesterOpsAiClient();
    const { decision, aiRunId, error } = await ai.decideMessage({
      workspaceId: event.workspaceId,
      eventId: event.id,
      messageText: event.messageText,
      directMention,
      usageSnapshot,
    });
    const allowed = new Set(policy.allowedActions);
    const safeAction = allowed.has(decision.safeAction) ? decision.safeAction : 'NONE';

    if (safeAction === 'ANSWER_GENERAL' && directMention && replyChatId) {
      const answer = await ai.answerGeneral({
        workspaceId: event.workspaceId,
        eventId: event.id,
        messageText: event.messageText,
        directMention,
        usageSnapshot,
        decisionSummary: decision.summary,
      });
      progress?.stop();
      await deliverReplyCard({
        workspaceId: event.workspaceId,
        chatId: replyChatId,
        progressMessageId,
        idempotencyKey: `general-answer:${event.id}`,
        card: buildTesterOpsGeneralCard({
          title: 'Timo',
          text: answer.answer.answer,
          template: answer.error ? 'orange' : 'blue',
          citations: answer.answer.citations,
        }),
      });
    } else if (safeAction === 'ANSWER_FROM_DOCS') {
      const chunks = await retrieveKnowledgeChunks(event.workspaceId, event.messageText);
      const answer = await ai.answerDocs({ workspaceId: event.workspaceId, eventId: event.id, question: event.messageText, chunks });
      const reply = answer.answer.answer ?? answer.answer.missingInfo ?? answer.answer.refusalReason;
      if (reply && replyChatId) {
        progress?.stop();
        await deliverReplyCard({
          workspaceId: event.workspaceId,
          chatId: replyChatId,
          progressMessageId,
          idempotencyKey: `doc-answer:${event.id}`,
          card: buildTesterOpsDocAnswerCard({
            question: event.messageText,
            answer: answer.answer,
            evidenceCount: chunks.length,
          }),
        });
      }
    } else if ((safeAction === 'GET_USAGE_STATUS' || safeAction === 'SEND_PING') && replyChatId && usageSnapshot) {
      progress?.stop();
      await deliverReplyCard({
        workspaceId: event.workspaceId,
        chatId: replyChatId,
        progressMessageId,
        idempotencyKey: safeAction === 'SEND_PING' ? `ping-request:${event.id}` : `usage:${event.id}`,
        card: safeAction === 'SEND_PING' ? buildTesterOpsPingCard(usageSnapshot) : buildTesterOpsUsageCard(usageSnapshot),
      });
    } else if (safeAction === 'LIST_ISSUES' && directMention && replyChatId) {
      const issueList = await buildTesterIssueListSnapshot(event.workspaceId, cfg.timezone);
      progress?.stop();
      await deliverReplyCard({
        workspaceId: event.workspaceId,
        chatId: replyChatId,
        progressMessageId,
        idempotencyKey: `issue-list:${event.id}`,
        card: buildTesterOpsIssueListCard(issueList),
      });
    } else if ((safeAction === 'LOG_ISSUE' || safeAction === 'ASK_CLARIFICATION') && decision.intent === 'ISSUE_REPORT') {
      const status = decision.confidence >= policy.highConfidenceThreshold ? 'OPEN' : 'CANDIDATE';
      await prisma.testerOpsIssue.create({
        data: {
          workspaceId: event.workspaceId,
          eventId: event.id,
          reporterMemberId: event.memberId,
          reporterOpenId: event.senderOpenId,
          reporterUserId: event.member?.userId,
          status,
          intent: decision.intent,
          category: decision.category,
          severity: decision.severity,
          confidence: decision.confidence,
          summary: decision.summary,
          sourceMessageText: event.messageText,
          sourceMessageId: event.messageId,
          clarifyingQuestion: decision.clarifyingQuestion,
          replyText: decision.replyText,
          citations: decision.citations,
          aiRunId,
        },
      });
      const shouldReply = replyChatId && (status === 'OPEN' || safeAction === 'ASK_CLARIFICATION' || directMention);
      if (shouldReply) {
        progress?.stop();
        await deliverReplyCard({
          workspaceId: event.workspaceId,
          chatId: replyChatId!,
          progressMessageId,
          idempotencyKey: `issue-reply:${event.id}`,
          card: buildTesterOpsIssueCard({ decision, status, sourceText: event.messageText }),
        });
      }
    } else if (directMention && decision.replyText && replyChatId) {
      progress?.stop();
      await deliverReplyCard({
        workspaceId: event.workspaceId,
        chatId: replyChatId,
        progressMessageId,
        idempotencyKey: `mention-reply:${event.id}`,
        card: buildTesterOpsGeneralCard({
          title: 'Timo',
          text: decision.replyText,
          template: error ? 'orange' : 'blue',
          citations: decision.citations,
        }),
      });
    } else if (directMention && replyChatId) {
      progress?.stop();
      await deliverReplyCard({
        workspaceId: event.workspaceId,
        chatId: replyChatId,
        progressMessageId,
        idempotencyKey: `mention-empty:${event.id}`,
        card: buildTesterOpsGeneralCard({
          title: 'Timo needs a sharper ask',
          text: 'I could not safely choose an action for that. Ask for tester status, a specific Timo doc question, or a clear issue report.',
          template: 'orange',
        }),
      });
    }

    await prisma.testerOpsEvent.update({
      where: { id: event.id },
      data: { status: error ? 'FAILED' : 'PROCESSED', processedAt: new Date(), error: error ?? null },
    });
    return { decision, safeAction, aiRunId, error };
  } finally {
    progress?.stop();
  }
}

async function startProgressCard(chatId: string, eventId: string, prompt: string): Promise<{ messageId: string | null; stop: () => void } | null> {
  const messenger = getTesterOpsLarkMessenger();
  if (!messenger) return null;
  try {
    const result = await messenger.sendCardToChat(chatId, buildTesterOpsThinkingCard({ prompt, frame: 0 }), `tester-ops-thinking:${eventId}`);
    if (hasTesterOpsStreamingImage()) return { messageId: result.messageId, stop: () => undefined };
    let stopped = false;
    let warned = false;
    let frame = 1;
    const timer = setInterval(() => {
      if (stopped) return;
      void messenger.updateCard(result.messageId, buildTesterOpsThinkingCard({ prompt, frame })).catch((err) => {
        if (!warned) {
          warned = true;
          logger.warn({ err: String(err), eventId }, 'tester ops progress animation failed');
        }
      });
      frame += 1;
    }, 1300);
    timer.unref?.();
    return {
      messageId: result.messageId,
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  } catch (err) {
    logger.warn({ err: String(err), eventId }, 'tester ops progress card failed');
    return null;
  }
}

async function deliverReplyCard(args: {
  workspaceId: string;
  chatId: string;
  progressMessageId: string | null;
  idempotencyKey: string;
  card: Record<string, unknown>;
}) {
  if (args.progressMessageId) {
    const messenger = getTesterOpsLarkMessenger();
    if (messenger) {
      try {
        await messenger.updateCard(args.progressMessageId, args.card);
        return;
      } catch (err) {
        logger.warn({ err: String(err), progressMessageId: args.progressMessageId }, 'tester ops progress card update failed');
      }
    }
  }
  await prisma.$transaction(async (tx) => {
    await enqueueTesterOpsCard(tx, {
      workspaceId: args.workspaceId,
      chatId: args.chatId,
      card: args.card,
      idempotencyKey: args.idempotencyKey,
    });
  });
}

async function buildTesterIssueListSnapshot(workspaceId: string, timezone: string): Promise<TesterIssueListSnapshot> {
  const where: Prisma.TesterOpsIssueWhereInput = { workspaceId, status: { in: ['OPEN', 'CANDIDATE'] } };
  const [items, grouped] = await Promise.all([
    prisma.testerOpsIssue.findMany({
      where,
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: 15,
      select: { status: true, severity: true, category: true, summary: true, reporterOpenId: true, createdAt: true },
    }),
    prisma.testerOpsIssue.groupBy({ by: ['severity', 'status'], where, _count: { _all: true } }),
  ]);
  const severityCounts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  let total = 0;
  let openCount = 0;
  let candidateCount = 0;
  for (const row of grouped) {
    const count = row._count._all;
    total += count;
    if (row.status === 'OPEN') openCount += count;
    if (row.status === 'CANDIDATE') candidateCount += count;
    severityCounts[row.severity] += count;
  }
  return {
    items: items.map((issue) => ({
      status: issue.status,
      severity: issue.severity,
      category: issue.category,
      summary: issue.summary,
      reporterOpenId: issue.reporterOpenId,
      createdAt: issue.createdAt.toISOString(),
    })),
    total,
    openCount,
    candidateCount,
    severityCounts,
    generatedAt: new Date().toISOString(),
    timezone,
  };
}

function parseLarkMessageEvent(raw: unknown): {
  workspaceId: string;
  sourceId: string;
  chatId: string | null;
  chatType: string | null;
  messageId: string | null;
  senderOpenId: string | null;
  senderType: string | null;
  messageText: string;
  raw: unknown;
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const root = raw as Record<string, unknown>;
  const event = root.event && typeof root.event === 'object' ? (root.event as Record<string, unknown>) : root;
  const message = event.message && typeof event.message === 'object' ? (event.message as Record<string, unknown>) : null;
  if (!message) return null;
  const sender = event.sender && typeof event.sender === 'object' ? (event.sender as Record<string, unknown>) : null;
  const senderId = sender?.sender_id && typeof sender.sender_id === 'object' ? (sender.sender_id as Record<string, unknown>) : null;
  const body = message.body && typeof message.body === 'object' ? (message.body as Record<string, unknown>) : null;
  const messageId = typeof message.message_id === 'string' ? message.message_id : null;
  const eventId = typeof root.event_id === 'string' ? root.event_id : messageId;
  if (!eventId) return null;
  return {
    workspaceId: env.WORKSPACE_ID,
    sourceId: eventId,
    chatId: typeof message.chat_id === 'string' ? message.chat_id : null,
    chatType: typeof message.chat_type === 'string' ? message.chat_type : null,
    messageId,
    senderOpenId: typeof senderId?.open_id === 'string' ? senderId.open_id : null,
    senderType: typeof sender?.sender_type === 'string' ? sender.sender_type : null,
    messageText: renderContent(typeof body?.content === 'string' ? body.content : '', message.mentions),
    raw,
  };
}

function isDirectTesterMessage(text: string, chatType?: string | null): boolean {
  return chatType === 'p2p' || isDirectMention(text);
}

function getLarkMessageChatType(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const root = raw as Record<string, unknown>;
  const event = root.event && typeof root.event === 'object' ? (root.event as Record<string, unknown>) : root;
  const message = event.message && typeof event.message === 'object' ? (event.message as Record<string, unknown>) : null;
  return typeof message?.chat_type === 'string' ? message.chat_type : null;
}

function renderContent(content: string, mentions?: unknown): string {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return renderMentions(typeof parsed.text === 'string' ? parsed.text : content, mentions);
  } catch {
    return renderMentions(content, mentions);
  }
}

function renderMentions(text: string, mentions: unknown): string {
  if (!Array.isArray(mentions)) return text;
  return mentions.reduce((next, mention) => {
    if (!mention || typeof mention !== 'object') return next;
    const item = mention as { key?: unknown; name?: unknown };
    if (typeof item.key !== 'string' || typeof item.name !== 'string') return next;
    return next.split(item.key).join(`@${item.name}`);
  }, text);
}
