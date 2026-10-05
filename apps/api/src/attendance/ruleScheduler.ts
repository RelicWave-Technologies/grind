import { prisma } from '@grind/db';
import { dateKeyInTimeZone } from '@grind/types';
import { logger } from '../logger';
import { reconcileMonthRules, resolveReportMonth } from '../reports/monthPerformanceData';

/**
 * Keeps the attendance rules' ledger lines current.
 *
 * Reading a report never writes the ledger. The lines are reconciled here —
 * every half hour for the current month, plus the previous one while time and
 * approvals for its last days may still be arriving — and shortly after the
 * writes that change a verdict (`requestRuleReconcile`). The reconcile judges
 * days with the same inputs the month report reads, so the two cannot disagree.
 */

const INTERVAL_MS = 30 * 60_000;

async function reconcileAttendanceRulesOnce(nowMs = Date.now(), onlyWorkspaceId?: string): Promise<number> {
  const policies = await prisma.leavePolicy.findMany({
    where: { attendanceRulesFrom: { not: null }, ...(onlyWorkspaceId ? { workspaceId: onlyWorkspaceId } : {}) },
    select: { workspaceId: true, attendanceRulesFrom: true, workspace: { select: { timezone: true } } },
  });

  let months = 0;
  for (const policy of policies) {
    const tz = policy.workspace.timezone;
    const users = await prisma.user.findMany({
      where: { workspaceId: policy.workspaceId, deactivatedAt: null },
      select: { id: true },
    });
    if (users.length === 0) continue;

    const today = dateKeyInTimeZone(new Date(nowMs), tz);
    const current = today.slice(0, 7);
    const [y, m] = current.split('-').map((n) => Number.parseInt(n, 10)) as [number, number];
    const previous = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    const firstMonth = policy.attendanceRulesFrom!.slice(0, 7);

    for (const month of [previous, current]) {
      if (month < firstMonth) continue;
      const range = resolveReportMonth({ month }, tz);
      if ('error' in range) continue;
      try {
        await reconcileMonthRules({
          workspaceId: policy.workspaceId,
          userIds: users.map((u) => u.id),
          range,
          nowMs,
        });
        months += 1;
      } catch (err) {
        logger.error({ err: String(err), workspaceId: policy.workspaceId, month }, 'attendance rules reconcile failed');
      }
    }
  }
  return months;
}

let timer: NodeJS.Timeout | null = null;
const pending = new Map<string, NodeJS.Timeout>();
const RECONCILE_DEBOUNCE_MS = 5_000;

/**
 * Reconcile one workspace's rule lines soon, after a write that can change a
 * verdict (an approved manual entry, a Lark leave or WFH decision). Debounced
 * so a burst of writes costs one reconcile. Off under test, where callers
 * reconcile explicitly.
 */
export function requestRuleReconcile(workspaceId: string): void {
  if (process.env.NODE_ENV === 'test') return;
  const existing = pending.get(workspaceId);
  if (existing) clearTimeout(existing);
  const handle = setTimeout(() => {
    pending.delete(workspaceId);
    reconcileAttendanceRulesOnce(Date.now(), workspaceId).catch((err) => {
      logger.error({ err: String(err), workspaceId }, 'attendance rules reconcile after write failed');
    });
  }, RECONCILE_DEBOUNCE_MS);
  handle.unref?.();
  pending.set(workspaceId, handle);
}

export function startAttendanceRulesScheduler(intervalMs = INTERVAL_MS): void {
  if (timer || process.env.NODE_ENV === 'test') return;
  const run = () => {
    reconcileAttendanceRulesOnce().catch((err) => {
      logger.error({ err: String(err) }, 'attendance rules scheduler crashed');
    });
  };
  // After the WFH ingest's first sweep, so approvals are in before days are judged.
  setTimeout(run, 2 * 60_000).unref?.();
  timer = setInterval(run, intervalMs);
  timer.unref?.();
  logger.info({ intervalMs }, 'attendance rules scheduler started');
}
