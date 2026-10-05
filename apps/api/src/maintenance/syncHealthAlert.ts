import { prisma } from '@grind/db';
import { logger } from '../logger';
import { reportMessage } from '../lib/errorReporter';
import {
  classifySyncHealth,
  SYNC_DIAGNOSTICS_STALE_MS,
  SYNC_HEALTH_SELECT,
  type SyncHealthDto,
} from '../agent/syncHealth';

/**
 * The stuck-sync alert: a WARN log plus a Sentry message, once per person per
 * episode.
 *
 * Runs on the maintenance scheduler (see startPruneScheduler). A person is
 * alerted when their verdict becomes STUCK (agent/syncHealth.ts); the
 * nullable `User.agentSyncAlertedAt` remembers it, so later passes stay quiet
 * until they recover. Recovery — the queue reported empty by a heartbeat, or a
 * fresh HEALTHY/BEHIND verdict here — clears it, and the next time they get
 * stuck they are alerted again. An offline person (UNKNOWN) is neither alerted
 * nor cleared: the laptop has not said anything new.
 *
 * Multi-instance safe: the claim is a conditional update, so of two instances
 * passing at once only one logs.
 *
 * No Lark message: the only Lark senders (manual-time cards, Tester Ops) are
 * bound to their own outboxes and recipients, and reusing them for an admin
 * alert is not a one-liner. The WARN line and Sentry are the alert.
 */

export interface SyncAlertPassResult {
  alerted: string[];
  cleared: number;
}

export async function runSyncHealthAlertOnce(now: Date = new Date()): Promise<SyncAlertPassResult> {
  const freshSince = new Date(now.getTime() - SYNC_DIAGNOSTICS_STALE_MS);
  const rows = await prisma.user.findMany({
    where: {
      deactivatedAt: null,
      OR: [
        // Only a fresh report with something pending can be stuck.
        { agentDiagnosticsUpdatedAt: { gte: freshSince }, agentSyncPending: { gt: 0 } },
        // Everyone already alerted, to notice they recovered.
        { agentSyncAlertedAt: { not: null } },
      ],
    },
    select: { id: true, workspaceId: true, agentSyncAlertedAt: true, ...SYNC_HEALTH_SELECT },
  });

  const alerted: string[] = [];
  let cleared = 0;
  for (const row of rows) {
    const health = classifySyncHealth(row, now);
    if (health.status === 'STUCK' && row.agentSyncAlertedAt === null) {
      const claim = await prisma.user.updateMany({
        where: { id: row.id, agentSyncAlertedAt: null },
        data: { agentSyncAlertedAt: now },
      });
      if (claim.count !== 1) continue;
      alerted.push(row.id);
      alertStuck(row.id, row.workspaceId, health);
    } else if (row.agentSyncAlertedAt !== null && (health.status === 'HEALTHY' || health.status === 'BEHIND')) {
      const reset = await prisma.user.updateMany({
        where: { id: row.id, agentSyncAlertedAt: { not: null } },
        data: { agentSyncAlertedAt: null },
      });
      cleared += reset.count;
    }
  }
  return { alerted, cleared };
}

function alertStuck(userId: string, workspaceId: string, health: SyncHealthDto): void {
  // Ids and codes only — never a name or email in logs or Sentry.
  const details = {
    userId,
    workspaceId,
    reason: health.reason,
    pending: health.pending,
    oldestPendingAgeMin: health.oldestPendingAgeMs === null ? null : Math.round(health.oldestPendingAgeMs / 60_000),
    lastError: health.lastError,
    lastErrorForMin: health.lastErrorForMs === null ? null : Math.round(health.lastErrorForMs / 60_000),
    agentVersion: health.agentVersion,
    platform: health.platform,
    osVersion: health.osVersion,
    arch: health.arch,
  };
  logger.warn(details, 'timo sync stuck: tracked time is not reaching the server');
  void reportMessage('Timo sync stuck', { userId, extras: details }, 'warning');
}
