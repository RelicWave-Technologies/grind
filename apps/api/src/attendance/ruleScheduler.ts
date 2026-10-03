import { prisma } from '@grind/db';
import { dateKeyInTimeZone } from '@grind/types';
import { logger } from '../logger';
import { loadMonthPerformanceReport, resolveReportMonth } from '../reports/monthPerformanceData';

/**
 * Keeps the attendance rules' ledger lines current without anybody opening a
 * report.
 *
 * The month report reconciles the rules every time it is built, so an export is
 * always exact. This covers the time between: a balance shown in the agent or
 * on the leave screen should already reflect yesterday's short day. Building
 * the report is the reconcile — one code path, so the two cannot disagree.
 *
 * Current month, plus the previous one while time and approvals for its last
 * days may still be arriving.
 */

const INTERVAL_MS = 30 * 60_000;

export async function reconcileAttendanceRulesOnce(nowMs = Date.now()): Promise<number> {
  const policies = await prisma.leavePolicy.findMany({
    where: { attendanceRulesFrom: { not: null } },
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
        await loadMonthPerformanceReport({
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
