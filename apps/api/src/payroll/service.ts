import { prisma, type PayrollPolicy, type PayrollRunLog, type PayrollSheetRecipientMode } from '@grind/db';
import {
  PAYROLL_POLICY_DEFAULTS,
  PayrollPolicySettingsSchema,
  type PayrollPolicyDto,
  type PayrollPolicySettings,
  type PayrollRunLogDto,
} from '@grind/types';
import { localDayWindow } from '../insights/day';
import { buildTimesheetMatrix, type TimesheetSegmentInput } from '../insights/timesheets';
import { loadTimeInvalidationsForUsers } from '../insights/timeInvalidations';
import { loadEntryLiveEvidence } from '../insights/liveEntryEvidence';
import { resolveEffectiveEntrySegmentEnds } from '../insights/openSegmentEvidence';
import {
  buildMonthlyPayroll,
  type MonthlyPayroll,
  type PayrollPolicyInput,
  type PayrollShiftAssignmentInput,
  type PayrollUserMeta,
} from './monthly';

export const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/u;

export interface ResolvedPayrollMonth {
  month: string;
  from: string;
  to: string;
  tz: string;
  rangeStart: Date;
  rangeEnd: Date;
}

export interface PayrollPayload {
  payroll: MonthlyPayroll;
  policy: PayrollPolicyDto;
  runs: PayrollRunLogDto[];
  unresolvedApprovalCount: number;
}

export function isPayrollMonth(v: unknown): v is string {
  return typeof v === 'string' && MONTH_RE.test(v);
}

export function lastDayOfMonth(year: number, monthIndex0: number): number {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

export function previousMonthKeyForLocalDate(localDate: string): string {
  const [y, m] = localDate.split('-').map((n) => Number.parseInt(n, 10));
  const d = new Date(Date.UTC(y || 1970, (m || 1) - 2, 1));
  return d.toISOString().slice(0, 7);
}

export function resolvePayrollMonth(
  query: Record<string, unknown>,
  fallbackTz = 'UTC',
): ResolvedPayrollMonth | { error: string } {
  const tz = typeof query.tz === 'string' && query.tz.length > 0 ? query.tz : fallbackTz;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    return { error: 'invalid_tz' };
  }

  let month: string;
  if (isPayrollMonth(query.month)) {
    month = query.month;
  } else if (query.month == null) {
    month = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
    })
      .format(new Date())
      .slice(0, 7);
  } else {
    return { error: 'invalid_month' };
  }

  const [y, m] = month.split('-').map((n) => Number.parseInt(n, 10));
  if (!y || !m) return { error: 'invalid_month' };
  const from = `${month}-01`;
  const to = `${month}-${String(lastDayOfMonth(y, m - 1)).padStart(2, '0')}`;
  const rangeStart = localDayWindow(from, tz)?.start;
  const rangeEnd = localDayWindow(to, tz)?.end;
  if (!rangeStart || !rangeEnd) return { error: 'invalid_date_or_tz' };
  return { month, from, to, tz, rangeStart, rangeEnd };
}

export async function loadOrCreatePayrollPolicy(workspaceId: string): Promise<PayrollPolicy> {
  return prisma.payrollPolicy.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      halfDayLowerMin: PAYROLL_POLICY_DEFAULTS.halfDayLowerMin,
      halfDayUpperMin: PAYROLL_POLICY_DEFAULTS.halfDayUpperMin,
      fullDayLowerMin: PAYROLL_POLICY_DEFAULTS.fullDayLowerMin,
      fullDayUpperMin: PAYROLL_POLICY_DEFAULTS.fullDayUpperMin,
      monthlyLowerMin: PAYROLL_POLICY_DEFAULTS.monthlyLowerMin,
      timezone: PAYROLL_POLICY_DEFAULTS.timezone,
      approvalReminderDays: [...PAYROLL_POLICY_DEFAULTS.approvalReminderDays],
      approvalReminderTime: PAYROLL_POLICY_DEFAULTS.approvalReminderTime,
      payrollSheetSendDay: PAYROLL_POLICY_DEFAULTS.payrollSheetSendDay,
      payrollSheetSendTime: PAYROLL_POLICY_DEFAULTS.payrollSheetSendTime,
      sendPayrollSheetTo: recipientModeToDb(PAYROLL_POLICY_DEFAULTS.sendPayrollSheetTo),
    },
    update: {},
  });
}

export async function patchPayrollPolicy(
  workspaceId: string,
  patch: Partial<PayrollPolicySettings>,
): Promise<PayrollPolicyDto | { error: string }> {
  const current = toPolicySettings(await loadOrCreatePayrollPolicy(workspaceId));
  const merged = { ...current, ...patch };
  const parsed = PayrollPolicySettingsSchema.safeParse(merged);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'invalid_payroll_policy' };
  }
  const saved = await prisma.payrollPolicy.update({
    where: { workspaceId },
    data: {
      halfDayLowerMin: parsed.data.halfDayLowerMin,
      halfDayUpperMin: parsed.data.halfDayUpperMin,
      fullDayLowerMin: parsed.data.fullDayLowerMin,
      fullDayUpperMin: parsed.data.fullDayUpperMin,
      monthlyLowerMin: parsed.data.monthlyLowerMin,
      timezone: parsed.data.timezone,
      approvalReminderDays: parsed.data.approvalReminderDays,
      approvalReminderTime: parsed.data.approvalReminderTime,
      payrollSheetSendDay: parsed.data.payrollSheetSendDay,
      payrollSheetSendTime: parsed.data.payrollSheetSendTime,
      sendPayrollSheetTo: recipientModeToDb(parsed.data.sendPayrollSheetTo),
    },
  });
  return toPolicyDto(saved);
}

export async function buildPayrollPayload(
  workspaceId: string,
  range: ResolvedPayrollMonth,
  nowMs = Date.now(),
): Promise<PayrollPayload | { error: string }> {
  const policy = await loadOrCreatePayrollPolicy(workspaceId);

  const users = await prisma.user.findMany({
    where: { workspaceId, deactivatedAt: null },
    select: {
      id: true,
      name: true,
      email: true,
      avatarUrl: true,
      role: true,
      teamId: true,
      team: { select: { name: true } },
    },
    orderBy: [{ role: 'asc' }, { name: 'asc' }],
  });

  const meta: PayrollUserMeta[] = users.map((u) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    avatarUrl: u.avatarUrl,
    role: u.role,
    teamId: u.teamId,
    teamName: u.team?.name ?? null,
  }));

  const userIds = users.map((u) => u.id);
  const lookbackStart = new Date(range.rangeStart.getTime() - 24 * 60 * 60 * 1000);
  const lookbackEnd = new Date(range.rangeEnd.getTime() + 24 * 60 * 60 * 1000);

  const [entries, shiftAssignments, runs, unresolvedApprovalCount, invalidations] =
    userIds.length === 0
      ? [[], [], [], 0, []]
      : await Promise.all([
          prisma.timeEntry.findMany({
            where: {
              userId: { in: userIds },
              startedAt: { lt: lookbackEnd },
              OR: [{ endedAt: null }, { endedAt: { gt: lookbackStart } }],
            },
            include: { segments: { select: { kind: true, startedAt: true, endedAt: true } } },
          }),
          prisma.shiftAssignment.findMany({
            where: {
              userId: { in: userIds },
              effectiveFrom: { lt: range.rangeEnd },
              OR: [{ effectiveTo: null }, { effectiveTo: { gt: range.rangeStart } }],
            },
            select: {
              userId: true,
              shiftId: true,
              effectiveFrom: true,
              effectiveTo: true,
              shiftNameSnapshot: true,
              scheduleSnapshot: true,
              bufferMinSnapshot: true,
            },
            orderBy: [{ userId: 'asc' }, { effectiveFrom: 'asc' }],
          }),
          prisma.payrollRunLog.findMany({
            where: { workspaceId, month: range.month },
            orderBy: { scheduledFor: 'desc' },
            take: 10,
          }),
          prisma.manualTimeRequest.count({
            where: {
              userId: { in: userIds },
              status: 'PENDING',
              requestedStart: { lt: range.rangeEnd },
              requestedEnd: { gt: range.rangeStart },
            },
          }),
          loadTimeInvalidationsForUsers(userIds, lookbackStart, lookbackEnd),
        ]);

  const now = new Date(nowMs);
  const evidenceByEntry = await loadEntryLiveEvidence(entries, now);
  const segs: TimesheetSegmentInput[] = [];
  for (const e of entries) {
    const effectiveEnds = resolveEffectiveEntrySegmentEnds({
      segments: e.segments,
      entryEndedAt: e.endedAt,
      now,
      evidence: evidenceByEntry.get(e.id),
      lifecycle: e,
    });
    for (const [index, s] of e.segments.entries()) {
      segs.push({
        userId: e.userId,
        source: e.source as 'AUTO' | 'MANUAL',
        segmentKind: s.kind as 'WORK' | 'MEETING' | 'IDLE_TRIMMED',
        startedAt: s.startedAt.getTime(),
        endedAt: (effectiveEnds[index] ?? now).getTime(),
      });
    }
  }

  const matrix = buildTimesheetMatrix({
    from: range.from,
    to: range.to,
    tz: range.tz,
    segments: segs,
    invalidations,
  });
  if (!matrix) return { error: 'invalid_date_or_tz' };

  const groupedAssignments: Record<string, PayrollShiftAssignmentInput[]> = {};
  for (const row of shiftAssignments) {
    (groupedAssignments[row.userId] ??= []).push({
      shiftId: row.shiftId,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      shiftNameSnapshot: row.shiftNameSnapshot,
      scheduleSnapshot: row.scheduleSnapshot,
    });
  }

  const payroll = buildMonthlyPayroll(
    {
      month: range.month,
      tz: range.tz,
      matrix,
      users: meta,
      policy: toPayrollPolicyInput(policy),
      shiftAssignments: groupedAssignments,
    },
    nowMs,
  );
  return {
    payroll,
    policy: toPolicyDto(policy),
    runs: runs.map(toRunLogDto),
    unresolvedApprovalCount,
  };
}

export function toPolicyDto(policy: PayrollPolicy): PayrollPolicyDto {
  return {
    ...toPolicySettings(policy),
    workspaceId: policy.workspaceId,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
  };
}

export function toPolicySettings(policy: PayrollPolicy): PayrollPolicySettings {
  return {
    halfDayLowerMin: policy.halfDayLowerMin,
    halfDayUpperMin: policy.halfDayUpperMin,
    fullDayLowerMin: policy.fullDayLowerMin,
    fullDayUpperMin: policy.fullDayUpperMin,
    monthlyLowerMin: policy.monthlyLowerMin,
    timezone: policy.timezone,
    approvalReminderDays: policy.approvalReminderDays,
    approvalReminderTime: policy.approvalReminderTime,
    payrollSheetSendDay: policy.payrollSheetSendDay,
    payrollSheetSendTime: policy.payrollSheetSendTime,
    sendPayrollSheetTo: recipientModeFromDb(policy.sendPayrollSheetTo),
  };
}

export function toPayrollPolicyInput(policy: PayrollPolicy): PayrollPolicyInput {
  return {
    halfDayLowerMin: policy.halfDayLowerMin,
    halfDayUpperMin: policy.halfDayUpperMin,
    fullDayLowerMin: policy.fullDayLowerMin,
    fullDayUpperMin: policy.fullDayUpperMin,
    monthlyLowerMin: policy.monthlyLowerMin,
  };
}

export function toRunLogDto(run: PayrollRunLog): PayrollRunLogDto {
  return {
    id: run.id,
    month: run.month,
    runType: run.runType,
    scheduledFor: run.scheduledFor.toISOString(),
    status: run.status,
    sentCount: run.sentCount,
    skippedNoLarkCount: run.skippedNoLarkCount,
    skippedUnassignedCount: run.skippedUnassignedCount,
    failedCount: run.failedCount,
    errors: run.errors,
    createdAt: run.createdAt.toISOString(),
  };
}

function recipientModeFromDb(mode: PayrollSheetRecipientMode): PayrollPolicySettings['sendPayrollSheetTo'] {
  if (mode === 'ALL_ADMINS') return 'all_admins';
  return 'all_admins';
}

function recipientModeToDb(mode: PayrollPolicySettings['sendPayrollSheetTo']): PayrollSheetRecipientMode {
  if (mode === 'all_admins') return 'ALL_ADMINS';
  return 'ALL_ADMINS';
}
