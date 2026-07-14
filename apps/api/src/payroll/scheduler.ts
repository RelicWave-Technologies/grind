import { prisma, type PayrollRunStatus, type PayrollRunType } from '@grind/db';
import { instantForZonedDateTime, zonedDateTimeParts } from '@grind/types';
import { buildPendingDigests } from '../digests/pendingDigest';
import { localDayWindow } from '../insights/day';
import { getLarkMessenger, type LarkMessenger } from '../lark';
import { buildPayrollReminderCard, type PayrollReminderItem } from '../lark/cards';
import { env } from '../env';
import { logger } from '../logger';
import {
  buildPayrollPayload,
  loadOrCreatePayrollPolicy,
  previousMonthKeyForLocalDate,
  resolvePayrollMonth,
} from './service';

const CHECK_INTERVAL_MS = 5 * 60 * 1000;

export interface PayrollSchedulerResult {
  checkedWorkspaces: number;
  runsCreated: number;
  runsSkippedDuplicate: number;
  sendsAttempted: number;
}

export interface PayrollSendOutcome {
  status: PayrollRunStatus;
  sentCount: number;
  skippedNoLarkCount: number;
  skippedUnassignedCount: number;
  failedCount: number;
  errors: Array<Record<string, unknown>>;
}

export function startPayrollMonthCloseScheduler(): void {
  if (env.NODE_ENV === 'test') return;
  let active = false;
  const tick = async () => {
    if (active) return;
    active = true;
    try {
      await runPayrollMonthCloseOnce();
    } catch (err) {
      logger.warn({ err }, 'payroll month-close scheduler failed');
    } finally {
      active = false;
    }
  };
  const handle = setInterval(tick, CHECK_INTERVAL_MS);
  handle.unref?.();
  setTimeout(tick, 10_000).unref?.();
}

export async function runPayrollMonthCloseOnce(
  now = new Date(),
  messenger: LarkMessenger | null = getLarkMessenger(),
): Promise<PayrollSchedulerResult> {
  const workspaces = await prisma.workspace.findMany({ select: { id: true } });
  const result: PayrollSchedulerResult = {
    checkedWorkspaces: workspaces.length,
    runsCreated: 0,
    runsSkippedDuplicate: 0,
    sendsAttempted: 0,
  };

  for (const workspace of workspaces) {
    const policy = await loadOrCreatePayrollPolicy(workspace.id);
    const local = localParts(now, policy.timezone);
    const due: Array<{ type: PayrollRunType; scheduledFor: Date }> = [];

    if (policy.approvalReminderDays.includes(local.day) && local.minutes >= hhmmToMinutes(policy.approvalReminderTime)) {
      due.push({
        type: 'APPROVAL_REMINDER',
        scheduledFor: scheduledDate(local.date, policy.timezone, policy.approvalReminderTime),
      });
    }
    if (policy.payrollSheetSendDay === local.day && local.minutes >= hhmmToMinutes(policy.payrollSheetSendTime)) {
      due.push({
        type: 'PAYROLL_SHEET',
        scheduledFor: scheduledDate(local.date, policy.timezone, policy.payrollSheetSendTime),
      });
    }

    const month = previousMonthKeyForLocalDate(local.date);
    for (const job of due) {
      const reserved = await reserveRun(workspace.id, month, job.type, job.scheduledFor);
      if (!reserved) {
        result.runsSkippedDuplicate += 1;
        continue;
      }
      result.runsCreated += 1;
      if (!messenger) {
        await prisma.payrollRunLog.update({
          where: { id: reserved.id },
          data: {
            status: 'SKIPPED',
          errors: { items: JSON.stringify([{ error: 'lark_not_configured' }]) },
          },
        });
        continue;
      }

      result.sendsAttempted += 1;
      const outcome =
        job.type === 'APPROVAL_REMINDER'
          ? await sendApprovalReminders(workspace.id, month, policy.timezone, now, messenger)
          : await sendPayrollSheet(workspace.id, month, policy.timezone, messenger);
      await prisma.payrollRunLog.update({
        where: { id: reserved.id },
        data: {
          status: outcome.status,
          sentCount: outcome.sentCount,
          skippedNoLarkCount: outcome.skippedNoLarkCount,
          skippedUnassignedCount: outcome.skippedUnassignedCount,
          failedCount: outcome.failedCount,
          errors: outcome.errors.length > 0 ? { items: JSON.stringify(outcome.errors) } : undefined,
        },
      });
    }
  }

  return result;
}

export async function sendApprovalReminders(
  workspaceId: string,
  month: string,
  tz: string,
  now: Date,
  messenger: LarkMessenger,
): Promise<PayrollSendOutcome> {
  const range = resolvePayrollMonth({ month, tz }, tz);
  if ('error' in range) return failedOutcome(range.error);
  const requests = await prisma.manualTimeRequest.findMany({
    where: {
      user: { workspaceId, deactivatedAt: null },
      status: 'PENDING',
      requestedStart: { lt: range.rangeEnd },
      requestedEnd: { gt: range.rangeStart },
    },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          larkIdentity: { select: { openId: true } },
          team: { select: { name: true } },
        },
      },
      approver: { select: { id: true, name: true, larkIdentity: { select: { openId: true } } } },
    },
    orderBy: [{ createdAt: 'asc' }],
  });

  let sentCount = 0;
  let skippedNoLarkCount = 0;
  let skippedUnassignedCount = 0;
  let failedCount = 0;
  const errors: Array<Record<string, unknown>> = [];

  const byRequester = new Map<string, typeof requests>();
  for (const req of requests) {
    const list = byRequester.get(req.userId) ?? [];
    list.push(req);
    byRequester.set(req.userId, list);
  }
  for (const group of byRequester.values()) {
    const requester = group[0]?.user;
    if (!requester?.larkIdentity?.openId) {
      skippedNoLarkCount += 1;
      continue;
    }
    try {
      await messenger.sendCard(
        requester.larkIdentity.openId,
        buildPayrollReminderCard({
          month,
          audience: 'requester',
          recipientName: requester.name,
          requests: reminderItemsFromRequests(group, now.getTime()),
          dashboardUrl: dashboardLink('/approvals'),
          generatedAt: now.getTime(),
          timeZone: tz,
        }),
      );
      sentCount += 1;
    } catch (err) {
      failedCount += 1;
      errors.push({ userId: requester.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const digests = buildPendingDigests(
    requests.map((r) => ({
      id: r.id,
      approverId: r.approverId,
      requesterId: r.userId,
      requesterName: r.user.name,
      requestedStart: r.requestedStart.getTime(),
      requestedEnd: r.requestedEnd.getTime(),
      createdAtMs: r.createdAt.getTime(),
      reason: r.reason,
    })),
    { now: now.getTime() },
  );
  const approverById = new Map(requests.map((r) => [r.approverId, r.approver]));
  for (const digest of digests) {
    if (digest.approverId === '__unassigned__') {
      skippedUnassignedCount += digest.totalCount;
      continue;
    }
    const approver = approverById.get(digest.approverId);
    if (!approver?.larkIdentity?.openId) {
      skippedNoLarkCount += 1;
      continue;
    }
    const approverRequests = requests.filter((r) => r.approverId === digest.approverId);
    const teamNames = Array.from(new Set(approverRequests.map((r) => r.user.team?.name).filter(Boolean)));
    try {
      await messenger.sendCard(
        approver.larkIdentity.openId,
        buildPayrollReminderCard({
          month,
          audience: 'approver',
          recipientName: approver.name,
          teamName: teamNames.length === 1 ? teamNames[0] : teamNames.length > 1 ? `${teamNames.length} teams` : null,
          requests: reminderItemsFromDigest(digest),
          dashboardUrl: dashboardLink('/approvals'),
          generatedAt: now.getTime(),
          timeZone: tz,
        }),
      );
      sentCount += 1;
    } catch (err) {
      failedCount += 1;
      errors.push({ approverId: digest.approverId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return finalizeOutcome({ sentCount, skippedNoLarkCount, skippedUnassignedCount, failedCount, errors });
}

export async function sendPayrollSheet(
  workspaceId: string,
  month: string,
  tz: string,
  messenger: LarkMessenger,
): Promise<PayrollSendOutcome> {
  const range = resolvePayrollMonth({ month, tz }, tz);
  if ('error' in range) return failedOutcome(range.error);
  const [payload, admins] = await Promise.all([
    buildPayrollPayload(workspaceId, range),
    prisma.user.findMany({
      where: { workspaceId, role: 'ADMIN', deactivatedAt: null },
      select: { id: true, name: true, larkIdentity: { select: { openId: true } } },
    }),
  ]);
  if ('error' in payload) return failedOutcome(payload.error);

  let sentCount = 0;
  let skippedNoLarkCount = 0;
  let failedCount = 0;
  const errors: Array<Record<string, unknown>> = [];
  const text = [
    `Payroll worksheet ready for ${month}`,
    '',
    `People: ${payload.payroll.rows.length}`,
    `Payable units: ${payload.payroll.totals.payableUnits.toFixed(2)}`,
    `Full/Half/Off: ${payload.payroll.totals.fullDays}/${payload.payroll.totals.halfDays}/${payload.payroll.totals.offDays}`,
    `Unresolved approvals: ${payload.unresolvedApprovalCount}`,
    '',
    dashboardLink(`/payroll?month=${month}`) ? `Open payroll: ${dashboardLink(`/payroll?month=${month}`)}` : 'Open Payroll in Grind to download CSV.',
  ].join('\n');

  for (const admin of admins) {
    const openId = admin.larkIdentity?.openId;
    if (!openId) {
      skippedNoLarkCount += 1;
      continue;
    }
    try {
      await messenger.sendText(openId, text);
      sentCount += 1;
    } catch (err) {
      failedCount += 1;
      errors.push({ adminId: admin.id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return finalizeOutcome({ sentCount, skippedNoLarkCount, skippedUnassignedCount: 0, failedCount, errors });
}

async function reserveRun(
  workspaceId: string,
  month: string,
  runType: PayrollRunType,
  scheduledFor: Date,
) {
  const existing = await prisma.payrollRunLog.findFirst({
    where: { workspaceId, month, runType, scheduledFor },
    select: { id: true },
  });
  if (existing) return null;
  try {
    return await prisma.payrollRunLog.create({
      data: {
        workspaceId,
        month,
        runType,
        scheduledFor,
        status: 'SKIPPED',
      },
      select: { id: true },
    });
  } catch (err) {
    if (isUniqueError(err)) return null;
    throw err;
  }
}

function isUniqueError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === 'P2002';
}

function localParts(now: Date, tz: string): { date: string; day: number; minutes: number } {
  const local = zonedDateTimeParts(now, tz);
  const date = `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
  return { date, day: local.day, minutes: local.hour * 60 + local.minute };
}

function scheduledDate(localDate: string, tz: string, hhmm: string): Date {
  const [year, month, day] = localDate.split('-').map((part) => Number.parseInt(part, 10));
  const requestedMinute = hhmmToMinutes(hhmm);
  for (let minute = requestedMinute; minute < 24 * 60; minute += 1) {
    try {
      return instantForZonedDateTime({
        year: year!,
        month: month!,
        day: day!,
        hour: Math.floor(minute / 60),
        minute: minute % 60,
        second: 0,
      }, tz);
    } catch {
      // A DST spring-forward gap has no real wall-clock instant. The first
      // valid minute after the requested local time is the least surprising
      // one-time schedule for that day.
    }
  }
  const win = localDayWindow(localDate, tz);
  if (!win) throw new Error('invalid_scheduled_local_date');
  return win.end;
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((n) => Number.parseInt(n, 10));
  return (h || 0) * 60 + (m || 0);
}

function finalizeOutcome(outcome: Omit<PayrollSendOutcome, 'status'>): PayrollSendOutcome {
  let status: PayrollRunStatus = 'SKIPPED';
  if (outcome.failedCount > 0 && outcome.sentCount > 0) status = 'PARTIAL';
  else if (outcome.failedCount > 0) status = 'FAILED';
  else if (outcome.sentCount > 0) status = 'SENT';
  return { ...outcome, status };
}

function failedOutcome(error: string): PayrollSendOutcome {
  return {
    status: 'FAILED',
    sentCount: 0,
    skippedNoLarkCount: 0,
    skippedUnassignedCount: 0,
    failedCount: 1,
    errors: [{ error }],
  };
}

function dashboardLink(path: string): string | undefined {
  if (!env.DASHBOARD_URL) return undefined;
  return new URL(path, env.DASHBOARD_URL).toString();
}

function reminderItemsFromRequests(
  requests: Array<{
    id: string;
    user: { name: string };
    requestedStart: Date;
    requestedEnd: Date;
    reason: string;
    taskSummary: string | null;
    createdAt: Date;
  }>,
  nowMs: number,
): PayrollReminderItem[] {
  return requests.map((req) => ({
    requestId: req.id,
    requesterName: req.user.name,
    taskSummary: req.taskSummary,
    startedAt: req.requestedStart.getTime(),
    endedAt: req.requestedEnd.getTime(),
    reason: req.reason,
    ageMs: Math.max(0, nowMs - req.createdAt.getTime()),
  }));
}

function reminderItemsFromDigest(digest: ReturnType<typeof buildPendingDigests>[number]): PayrollReminderItem[] {
  return [...digest.stuck, ...digest.fresh].map((item) => ({
    requestId: item.requestId,
    requesterName: item.requesterName,
    startedAt: item.requestedStart,
    endedAt: item.requestedEnd,
    reason: item.reason,
    ageMs: item.ageMs,
  }));
}
