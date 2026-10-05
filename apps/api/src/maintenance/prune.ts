import { prisma, type Prisma } from '@grind/db';
import { env } from '../env';
import { logger } from '../logger';
import { onShutdown } from '../lib/lifecycle';

/**
 * Daily prune of bookkeeping rows that only ever grow.
 *
 * Every refresh rotation leaves a revoked RefreshToken behind (an agent rotates
 * every ~15 minutes, so ~100 rows per person per day), every agent sign-in an
 * AgentAuthCode, every manual-time card an outbox event and a message ledger
 * row. None of them is read again once it is settled and old:
 *
 *   - RefreshToken: expired, or revoked, more than 7 days ago. Reuse detection
 *     only needs a spent token for the grace window (minutes); a week is slack.
 *   - AgentAuthCode: expired (they live 120s and are single-use).
 *   - ManualTimeLarkOutboxEvent: DONE more than 30 days ago.
 *   - ManualTimeLarkMessage: in a terminal state (superseded, decided,
 *     cancelled, stale) and untouched for 90 days — the request was settled
 *     long ago and the card will not change again.
 *
 *   - AgentCommand: a developer command the agent never completed within
 *     7 days is marked EXPIRED (not deleted, so the developer page shows it);
 *     completed ones (DONE/FAILED/EXPIRED) are deleted 30 days after that.
 *
 * Activity samples are deliberately NOT pruned here: they are the evidence
 * behind every report, production has no backups, and how long to keep them
 * is a workspace-policy decision rather than housekeeping.
 *
 * One scheduler; multi-instance safe. Each run takes a transaction-scoped
 * advisory lock with try-lock semantics, so a second instance whose timer fires
 * at the same moment skips instead of deleting alongside.
 */

const DAY_MS = 24 * 60 * 60_000;
export const REFRESH_TOKEN_RETENTION_MS = 7 * DAY_MS;
export const OUTBOX_DONE_RETENTION_MS = 30 * DAY_MS;
export const LARK_MESSAGE_TERMINAL_RETENTION_MS = 90 * DAY_MS;
export const AGENT_COMMAND_EXPIRY_MS = 7 * DAY_MS;
export const AGENT_COMMAND_RETENTION_MS = 30 * DAY_MS;
export const TERMINAL_LARK_MESSAGE_STATUSES = ['SUPERSEDED', 'DECIDED', 'CANCELLED', 'STALE'] as const;

const PRUNE_LOCK_NAMESPACE = 742019652;
const PRUNE_LOCK_KEY = 1;
const PRUNE_BATCH_SIZE = 10_000;
const PRUNE_TX_TIMEOUT_MS = 10 * 60_000;
const PRUNE_INTERVAL_MS = DAY_MS;
const PRUNE_INITIAL_DELAY_MS = 10 * 60_000;

/** What gets deleted, as of `now`. Pure, so the predicates are testable alone. */
export function prunePredicates(now: Date) {
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const refreshCutoff = ago(REFRESH_TOKEN_RETENTION_MS);
  return {
    refreshToken: {
      OR: [{ expiresAt: { lt: refreshCutoff } }, { revokedAt: { lt: refreshCutoff } }],
    } satisfies Prisma.RefreshTokenWhereInput,
    agentAuthCode: {
      expiresAt: { lt: now },
    } satisfies Prisma.AgentAuthCodeWhereInput,
    manualTimeOutbox: {
      status: 'DONE',
      processedAt: { lt: ago(OUTBOX_DONE_RETENTION_MS) },
    } satisfies Prisma.ManualTimeLarkOutboxEventWhereInput,
    manualTimeLarkMessage: {
      status: { in: [...TERMINAL_LARK_MESSAGE_STATUSES] },
      updatedAt: { lt: ago(LARK_MESSAGE_TERMINAL_RETENTION_MS) },
    } satisfies Prisma.ManualTimeLarkMessageWhereInput,
    agentCommandToExpire: {
      status: { in: ['PENDING', 'DELIVERED'] },
      createdAt: { lt: ago(AGENT_COMMAND_EXPIRY_MS) },
    } satisfies Prisma.AgentCommandWhereInput,
    agentCommand: {
      status: { in: ['DONE', 'FAILED', 'EXPIRED'] },
      completedAt: { lt: ago(AGENT_COMMAND_RETENTION_MS) },
    } satisfies Prisma.AgentCommandWhereInput,
  };
}

export interface PruneResult {
  refreshTokens: number;
  agentAuthCodes: number;
  manualTimeOutboxEvents: number;
  manualTimeLarkMessages: number;
  agentCommandsExpired: number;
  agentCommands: number;
}

type Tx = Prisma.TransactionClient;

/** Delete in id batches so one run never issues a single unbounded statement. */
async function deleteBatched(
  find: () => Promise<Array<{ id: string }>>,
  remove: (ids: string[]) => Promise<{ count: number }>,
): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = await find();
    if (rows.length === 0) return total;
    total += (await remove(rows.map((r) => r.id))).count;
    if (rows.length < PRUNE_BATCH_SIZE) return total;
  }
}

/**
 * One prune pass. Returns null when another instance holds the lock.
 */
export async function runPruneOnce(now: Date = new Date()): Promise<PruneResult | null> {
  const where = prunePredicates(now);
  return prisma.$transaction(async (tx: Tx) => {
    const [lock] = await tx.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_try_advisory_xact_lock(${PRUNE_LOCK_NAMESPACE}::integer, ${PRUNE_LOCK_KEY}::integer) AS "locked"
    `;
    if (!lock?.locked) return null;
    const take = PRUNE_BATCH_SIZE;
    const select = { id: true } as const;

    const refreshTokens = await deleteBatched(
      () => tx.refreshToken.findMany({ where: where.refreshToken, select, take }),
      (ids) => tx.refreshToken.deleteMany({ where: { id: { in: ids } } }),
    );
    const agentAuthCodes = await deleteBatched(
      () => tx.agentAuthCode.findMany({ where: where.agentAuthCode, select, take }),
      (ids) => tx.agentAuthCode.deleteMany({ where: { id: { in: ids } } }),
    );
    const manualTimeOutboxEvents = await deleteBatched(
      () => tx.manualTimeLarkOutboxEvent.findMany({ where: where.manualTimeOutbox, select, take }),
      (ids) => tx.manualTimeLarkOutboxEvent.deleteMany({ where: { id: { in: ids } } }),
    );
    const manualTimeLarkMessages = await deleteBatched(
      () => tx.manualTimeLarkMessage.findMany({ where: where.manualTimeLarkMessage, select, take }),
      (ids) => tx.manualTimeLarkMessage.deleteMany({ where: { id: { in: ids } } }),
    );
    // Expire first, stamping completedAt, so the 30-day clock starts now.
    const { count: agentCommandsExpired } = await tx.agentCommand.updateMany({
      where: where.agentCommandToExpire,
      data: { status: 'EXPIRED', completedAt: now },
    });
    const agentCommands = await deleteBatched(
      () => tx.agentCommand.findMany({ where: where.agentCommand, select, take }),
      (ids) => tx.agentCommand.deleteMany({ where: { id: { in: ids } } }),
    );
    return {
      refreshTokens,
      agentAuthCodes,
      manualTimeOutboxEvents,
      manualTimeLarkMessages,
      agentCommandsExpired,
      agentCommands,
    };
  }, { timeout: PRUNE_TX_TIMEOUT_MS, maxWait: 10_000 });
}

let started = false;

export function startPruneScheduler(): void {
  if (started || env.NODE_ENV === 'test') return;
  started = true;
  let active = false;
  const tick = async () => {
    if (active) return;
    active = true;
    try {
      const result = await runPruneOnce();
      if (result) logger.info(result, 'prune: removed settled bookkeeping rows');
    } catch (err) {
      logger.warn({ err: String(err) }, 'prune failed');
    } finally {
      active = false;
    }
  };
  const handle = setInterval(() => void tick(), PRUNE_INTERVAL_MS);
  handle.unref?.();
  const first = setTimeout(() => void tick(), PRUNE_INITIAL_DELAY_MS);
  first.unref?.();
  onShutdown(() => {
    clearInterval(handle);
    clearTimeout(first);
  });
}
