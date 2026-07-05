import { prisma } from '@grind/db';
import { env } from '../env';
import { logger } from '../logger';
import { buildTesterOpsGeneralCard, buildTesterOpsPingCard } from './cards';
import { isDirectMention, loadOrCreateTesterOpsConfig } from './config';
import { ingestHistoryMessage } from './inbound';
import { getTesterOpsLarkMessenger } from './larkRuntime';
import { enqueueTesterOpsCard, processTesterOpsOutbox } from './outbox';
import { buildTesterUsageSnapshot } from './usage';

let started = false;
let tickInFlight = false;

export function startTesterOpsSchedulers(): void {
  if (started || env.TIMO_TESTER_BOT_ENABLED !== 'true') return;
  started = true;
  void runTick();
  setInterval(() => void runTick(), env.TIMO_TESTER_HISTORY_POLL_INTERVAL_MS);
  setInterval(() => void processTesterOpsOutbox().catch((err) => logger.error({ err: String(err) }, 'tester ops outbox failed')), 10_000);
}

async function runTick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    await tick();
  } catch (err) {
    logger.error({ err: String(err) }, 'tester ops scheduler tick failed');
  } finally {
    tickInFlight = false;
  }
}

async function tick(): Promise<void> {
  const cfg = await loadOrCreateTesterOpsConfig(env.WORKSPACE_ID);
  if (!cfg.enabled || !cfg.chatId) return;
  await maybeAnnounce(cfg.workspaceId, cfg.chatId);
  await maybeSendScheduledPing(cfg.workspaceId, cfg.chatId, cfg.timezone, cfg.pingTimes);
  await pollHistory(cfg.workspaceId, cfg.chatId, cfg.lastHistoryPollAt, cfg.passiveIssueDetectionEnabled);
}

async function maybeAnnounce(workspaceId: string, chatId: string): Promise<void> {
  const cfg = await prisma.testerOpsConfig.findUnique({ where: { workspaceId } });
  if (!cfg || cfg.announcementSentAt) return;
  await prisma.$transaction(async (tx) => {
    await enqueueTesterOpsCard(tx, {
      workspaceId,
      chatId,
      card: buildTesterOpsGeneralCard({
        title: 'Timo tester ops is live',
        text: "I'll help track Timo testing here. I may detect issue reports from this tester group and log them into Tester Ops. Mention me for help, status, or doc questions.",
        template: 'blue',
      }),
      idempotencyKey: `tester-ops-announcement:${workspaceId}`,
    });
    await tx.testerOpsConfig.update({ where: { workspaceId }, data: { announcementSentAt: new Date() } });
  });
}

async function maybeSendScheduledPing(workspaceId: string, chatId: string, timezone: string, pingTimes: string[]): Promise<void> {
  const now = new Date();
  const local = localParts(now, timezone);
  if (!pingTimes.includes(local.hhmm)) return;
  const scheduledFor = new Date(Math.floor(now.getTime() / 60000) * 60000);
  const existing = await prisma.testerOpsReminder.findUnique({ where: { workspaceId_scheduledFor: { workspaceId, scheduledFor } } });
  if (existing) return;
  const usage = await buildTesterUsageSnapshot(workspaceId, timezone);
  await prisma.$transaction(async (tx) => {
    const reminder = await tx.testerOpsReminder.create({
      data: { workspaceId, scheduledFor, usageSnapshot: usage },
    });
    await enqueueTesterOpsCard(tx, {
      workspaceId,
      chatId,
      card: buildTesterOpsPingCard(usage),
      idempotencyKey: `tester-ops-ping:${reminder.id}`,
    });
  });
}

async function pollHistory(workspaceId: string, chatId: string, lastHistoryPollAt: Date | null, includePassive: boolean): Promise<void> {
  const messenger = getTesterOpsLarkMessenger();
  if (!messenger?.listChatMessages) return;
  const end = new Date();
  const start = lastHistoryPollAt ?? new Date(end.getTime() - 10 * 60_000);
  const result = await messenger.listChatMessages({ chatId, start, end, pageSize: 50 });
  for (const message of result.messages) {
    if (!includePassive && !isDirectMention(message.content)) continue;
    await ingestHistoryMessage({
      workspaceId,
      chatId,
      messageId: message.messageId,
      senderOpenId: message.senderOpenId,
      messageText: message.content,
      createTimeMs: message.createTimeMs,
    });
  }
  await prisma.testerOpsConfig.update({ where: { workspaceId }, data: { lastHistoryPollAt: end, pollCursor: result.pageToken } });
}

function localParts(date: Date, timeZone: string): { hhmm: string } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  return { hhmm: `${hour}:${minute}` };
}
