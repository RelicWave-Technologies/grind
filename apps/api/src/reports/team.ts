import type {
  MemberReportDay,
  MemberReportTopApp,
  TeamReportAttentionItem,
  TeamReportMember,
  TeamReportsResponse,
  TeamReportUser,
} from '@grind/types';
import type { ReportRange } from './member';

const LOW_ACTIVITY_THRESHOLD = 25;
const MAX_ATTENTION_ITEMS = 12;

export function buildTeamReportsResponse(input: {
  range: ReportRange;
  users: TeamReportUser[];
  daysByUser: Map<string, MemberReportDay[]>;
}): TeamReportsResponse {
  const members = input.users.map((user) => {
    const days = input.daysByUser.get(user.id) ?? [];
    return summarizeMember(user, days);
  });

  const summary = summarizeTeam(members, input.range.days.length);
  const attention = buildAttention(members);

  return {
    from: input.range.from,
    to: input.range.to,
    tz: input.range.tz,
    days: input.range.days,
    summary,
    attention,
    members,
  };
}

function summarizeMember(user: TeamReportUser, days: MemberReportDay[]): TeamReportMember {
  let workedMs = 0;
  let manualMs = 0;
  let invalidatedMs = 0;
  let activeDays = 0;
  let lateDays = 0;
  let onTimeDays = 0;
  let offDays = 0;
  let noActivityDays = 0;
  let gapCount = 0;
  let gapMs = 0;
  let approved = 0;
  let pending = 0;
  let rejected = 0;
  let screenshots = 0;
  let activitySum = 0;
  let activityCount = 0;

  for (const day of days) {
    const dayWorkedMs = totalWorkedMs(day);
    workedMs += dayWorkedMs;
    manualMs += day.manualMs;
    invalidatedMs += day.invalidatedMs;
    if (dayWorkedMs > 0) activeDays += 1;
    if (day.shiftStatus === 'late') lateDays += 1;
    if (day.shiftStatus === 'on_time' || day.shiftStatus === 'early') onTimeDays += 1;
    if (day.shiftStatus === 'no_shift') offDays += 1;
    if (day.shiftStatus === 'no_activity') noActivityDays += 1;
    gapCount += day.gaps.count;
    gapMs += day.gaps.totalMs;
    approved += day.approvals.approved;
    pending += day.approvals.pending;
    rejected += day.approvals.rejected;
    screenshots += day.screenshots.count;
    if (day.activityPercent !== null) {
      activitySum += day.activityPercent;
      activityCount += 1;
    }
  }

  return {
    user,
    workedMs,
    manualMs,
    invalidatedMs,
    activeDays,
    lateDays,
    onTimeDays,
    offDays,
    noActivityDays,
    gapCount,
    gapMs,
    approvals: { approved, pending, rejected },
    activityPercent: activityCount > 0 ? Math.round(activitySum / activityCount) : null,
    screenshots,
    topApps: aggregateTopApps(days),
    days,
  };
}

function summarizeTeam(members: TeamReportMember[], rangeDayCount: number): TeamReportsResponse['summary'] {
  let workedMs = 0;
  let manualMs = 0;
  let invalidatedMs = 0;
  let activeDays = 0;
  let lateDays = 0;
  let noActivityDays = 0;
  let gapCount = 0;
  let gapMs = 0;
  let pendingApprovals = 0;
  let screenshots = 0;
  let activitySum = 0;
  let activityCount = 0;

  for (const member of members) {
    workedMs += member.workedMs;
    manualMs += member.manualMs;
    invalidatedMs += member.invalidatedMs;
    activeDays += member.activeDays;
    lateDays += member.lateDays;
    noActivityDays += member.noActivityDays;
    gapCount += member.gapCount;
    gapMs += member.gapMs;
    pendingApprovals += member.approvals.pending;
    screenshots += member.screenshots;
    if (member.activityPercent !== null) {
      activitySum += member.activityPercent;
      activityCount += 1;
    }
  }

  return {
    memberCount: members.length,
    workedMs,
    manualMs,
    invalidatedMs,
    activeDays,
    memberDays: members.length * rangeDayCount,
    lateDays,
    noActivityDays,
    gapCount,
    gapMs,
    pendingApprovals,
    activityPercent: activityCount > 0 ? Math.round(activitySum / activityCount) : null,
    screenshots,
  };
}

function buildAttention(members: TeamReportMember[]): TeamReportAttentionItem[] {
  const items: TeamReportAttentionItem[] = [];
  for (const member of members) {
    for (const day of member.days) {
      const prefix = `${member.user.id}:${day.date}`;
      if (day.approvals.pending > 0) {
        items.push({
          id: `${prefix}:pending`,
          userId: member.user.id,
          userName: member.user.name,
          date: day.date,
          kind: 'pending_approval',
          severity: 'warn',
          title: 'Pending approval',
          detail: `${day.approvals.pending} waiting`,
        });
      }
      if (day.shiftStatus === 'late') {
        items.push({
          id: `${prefix}:late`,
          userId: member.user.id,
          userName: member.user.name,
          date: day.date,
          kind: 'late',
          severity: 'danger',
          title: 'Late start',
          detail: day.firstActivityMs ? 'First activity after shift window' : 'Start time missing',
        });
      }
      if (day.shiftStatus === 'no_activity') {
        items.push({
          id: `${prefix}:no-activity`,
          userId: member.user.id,
          userName: member.user.name,
          date: day.date,
          kind: 'no_activity',
          severity: 'warn',
          title: 'No activity',
          detail: 'Assigned shift with no captured work',
        });
      }
      if (day.gaps.count > 0) {
        items.push({
          id: `${prefix}:gap`,
          userId: member.user.id,
          userName: member.user.name,
          date: day.date,
          kind: 'gap',
          severity: 'warn',
          title: 'Missing time',
          detail: `${day.gaps.count} gap${day.gaps.count === 1 ? '' : 's'} · ${formatDuration(day.gaps.totalMs)}`,
        });
      }
      if (autoTrackedMs(day) > 0 && day.activityPercent === null) {
        items.push({
          id: `${prefix}:missing-activity`,
          userId: member.user.id,
          userName: member.user.name,
          date: day.date,
          kind: 'missing_activity',
          severity: 'warn',
          title: 'Evidence missing',
          detail: 'Automatic time has no activity samples',
        });
      }
      if (day.activityPercent !== null && autoTrackedMs(day) > 0 && day.activityPercent < LOW_ACTIVITY_THRESHOLD) {
        items.push({
          id: `${prefix}:low-activity`,
          userId: member.user.id,
          userName: member.user.name,
          date: day.date,
          kind: 'low_activity',
          severity: 'neutral',
          title: 'Low activity',
          detail: `${day.activityPercent}% activity`,
        });
      }
    }
  }

  return items
    .sort((a, b) => {
      const severityDelta = severityRank(a.severity) - severityRank(b.severity);
      if (severityDelta !== 0) return severityDelta;
      if (a.date !== b.date) return a.date < b.date ? 1 : -1;
      return a.userName.localeCompare(b.userName);
    })
    .slice(0, MAX_ATTENTION_ITEMS);
}

function aggregateTopApps(days: MemberReportDay[]): MemberReportTopApp[] {
  const byApp = new Map<string, MemberReportTopApp>();
  let totalMinutes = 0;
  for (const day of days) {
    for (const app of day.topApps) {
      if (app.minutes <= 0) continue;
      const key = `${app.app}\x00${app.appBundle ?? ''}`;
      const current = byApp.get(key);
      if (current) {
        current.minutes += app.minutes;
      } else {
        byApp.set(key, { ...app, share: 0 });
      }
      totalMinutes += app.minutes;
    }
  }
  return Array.from(byApp.values())
    .map((app) => ({ ...app, share: totalMinutes > 0 ? app.minutes / totalMinutes : 0 }))
    .sort((a, b) => {
      if (b.minutes !== a.minutes) return b.minutes - a.minutes;
      return a.app.localeCompare(b.app);
    })
    .slice(0, 3);
}

function totalWorkedMs(day: MemberReportDay): number {
  return day.workedMs + day.meetingMs + day.manualMs;
}

function autoTrackedMs(day: MemberReportDay): number {
  return day.workedMs + day.meetingMs;
}

function severityRank(severity: TeamReportAttentionItem['severity']): number {
  if (severity === 'danger') return 0;
  if (severity === 'warn') return 1;
  return 2;
}

function formatDuration(ms: number): string {
  if (ms <= 0) return '0m';
  const min = Math.round(ms / 60_000);
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
