import { prisma } from '@grind/db';
import { env } from '../env';
import { logger } from '../logger';
import { buildTesterOpsGeneralCard, buildTesterOpsUsageCard } from './cards';
import { isDirectMention, loadOrCreateTesterOpsConfig } from './config';
import { ingestHistoryMessage } from './inbound';
import { getTesterOpsLarkMessenger } from './larkRuntime';
import { enqueueTesterOpsCard, processTesterOpsOutbox } from './outbox';
import { buildTesterUsageSnapshot } from './usage';

let started = false;
let tickInFlight = false;
let lastMaintenanceAt = 0;

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
  await maybeRunMaintenance();
  const cfg = await loadOrCreateTesterOpsConfig(env.WORKSPACE_ID);
  if (!cfg.enabled || !cfg.chatId) return;
  await maybeAnnounce(cfg.workspaceId, cfg.chatId);
  await maybeSendScheduledStatus(cfg.workspaceId, cfg.chatId, cfg.timezone, cfg.pingTimes);
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

async function maybeSendScheduledStatus(workspaceId: string, chatId: string, timezone: string, pingTimes: string[]): Promise<void> {
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
      card: buildTesterOpsUsageCard(usage),
      idempotencyKey: `tester-ops-status:${reminder.id}`,
    });
  });
}

/** Upper bound on one tick's paging so a huge backlog cannot stall the tick. */
const HISTORY_MAX_PAGES_PER_TICK = 20;
/**
 * How far back the poller is willing to reach after downtime. Answering a
 * day-old @mention is still useful; answering one from last week is noise.
 */
const HISTORY_MAX_LOOKBACK_MS = 24 * 60 * 60_000;

/**
 * Read the configured chat's history since the last message we handled.
 *
 * Every page is read (Lark returns at most 50 per page), and the resume point
 * only moves to the createTime of the newest message actually handled — never
 * to wall-clock "now" — so a backlog after downtime or a tick that stops early
 * is picked up on the next tick instead of being skipped. Lark's window is
 * whole seconds, so consecutive polls overlap by up to a second; that overlap
 * is harmless because ingest dedupes on messageId.
 */
export async function pollHistory(
  workspaceId: string,
  chatId: string,
  lastHistoryPollAt: Date | null,
  includePassive: boolean,
): Promise<void> {
  const messenger = getTesterOpsLarkMessenger();
  if (!messenger?.listChatMessages) return;
  const end = new Date();
  const floor = new Date(end.getTime() - HISTORY_MAX_LOOKBACK_MS);
  const start = lastHistoryPollAt
    ? new Date(Math.max(lastHistoryPollAt.getTime(), floor.getTime()))
    : new Date(end.getTime() - 10 * 60_000);

  let newestHandledMs: number | null = null;
  let pageToken: string | null = null;
  try {
    for (let page = 0; page < HISTORY_MAX_PAGES_PER_TICK; page += 1) {
      const result = await messenger.listChatMessages({ chatId, start, end, pageSize: 50, pageToken });
      for (const message of result.messages) {
        // Strictly older than the resume point = handled on an earlier tick.
        // Messages AT the resume point are re-offered (same-millisecond
        // neighbours) and simply deduped by ingest.
        if (lastHistoryPollAt && message.createTimeMs < lastHistoryPollAt.getTime()) continue;
        if (includePassive || isDirectMention(message.content)) {
          await ingestHistoryMessage({
            workspaceId,
            chatId,
            messageId: message.messageId,
            senderOpenId: message.senderOpenId,
            messageText: message.content,
            createTimeMs: message.createTimeMs,
          });
        }
        if (newestHandledMs === null || message.createTimeMs > newestHandledMs) newestHandledMs = message.createTimeMs;
      }
      if (!result.hasMore || !result.pageToken) break;
      pageToken = result.pageToken;
    }
  } finally {
    // Persist progress even when a page or an ingest failed part-way: what was
    // handled stays handled, and the next tick resumes right after it.
    if (newestHandledMs !== null && newestHandledMs > (lastHistoryPollAt?.getTime() ?? 0)) {
      await prisma.testerOpsConfig.update({
        where: { workspaceId },
        data: { lastHistoryPollAt: new Date(newestHandledMs) },
      });
    }
  }
}

const MAINTENANCE_INTERVAL_MS = 60 * 60_000;
/** Audit rows (events, AI runs, delivered outbox rows) are kept this long. */
export const TESTER_OPS_RETENTION_MS = 90 * 24 * 60 * 60_000;
/** A claim this old belongs to a worker that died mid-reply. */
const ABANDONED_EVENT_MS = 15 * 60_000;

async function maybeRunMaintenance(): Promise<void> {
  if (Date.now() - lastMaintenanceAt < MAINTENANCE_INTERVAL_MS) return;
  lastMaintenanceAt = Date.now();
  try {
    await runTesterOpsMaintenance();
  } catch (err) {
    logger.warn({ err: String(err) }, 'tester ops maintenance failed');
  }
}

/**
 * Housekeeping for the bot's own tables, safe to call from every API replica:
 *
 * - Events stuck in PROCESSING (the worker died mid-reply) are closed as
 *   FAILED rather than re-answered — a late duplicate answer is worse than
 *   none, and the row keeps the message for inspection.
 * - TesterOpsEvent / TesterOpsAiRun rows and DONE outbox rows older than 90
 *   days are deleted. Issues survive: their event/aiRun links are SET NULL and
 *   they carry their own copy of the source text. FAILED / DEAD_LETTER outbox
 *   rows are kept for inspection.
 *
 * The prune runs under a transaction-scoped advisory lock, so concurrent
 * replicas never run it twice at once (the loser just skips this round).
 */
export async function runTesterOpsMaintenance(now = new Date()): Promise<{
  abandoned: number;
  pruned: { events: number; aiRuns: number; outbox: number } | null;
}> {
  const abandoned = await prisma.testerOpsEvent.updateMany({
    where: { status: 'PROCESSING', updatedAt: { lt: new Date(now.getTime() - ABANDONED_EVENT_MS) } },
    data: { status: 'FAILED', processedAt: now, error: 'processing_abandoned' },
  });

  const cutoff = new Date(now.getTime() - TESTER_OPS_RETENTION_MS);
  const pruned = await prisma.$transaction(
    async (tx) => {
      const [lock] = await tx.$queryRaw<Array<{ locked: boolean }>>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${'timo-tester-ops-prune'}, 0)) AS "locked"
      `;
      if (!lock?.locked) return null;
      const aiRuns = await tx.testerOpsAiRun.deleteMany({ where: { createdAt: { lt: cutoff } } });
      const events = await tx.testerOpsEvent.deleteMany({
        where: { receivedAt: { lt: cutoff }, status: { notIn: ['PENDING', 'PROCESSING'] } },
      });
      const outbox = await tx.testerOpsOutboxEvent.deleteMany({ where: { status: 'DONE', createdAt: { lt: cutoff } } });
      return { events: events.count, aiRuns: aiRuns.count, outbox: outbox.count };
    },
    { timeout: 60_000 },
  );
  if (abandoned.count > 0 || (pruned && pruned.events + pruned.aiRuns + pruned.outbox > 0)) {
    logger.info({ abandoned: abandoned.count, pruned }, 'tester ops maintenance');
  }
  return { abandoned: abandoned.count, pruned };
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
