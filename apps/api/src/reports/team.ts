import type {
  MemberReportDay,
  MemberReportTopApp,
  TeamReportMember,
  TeamReportsSummaryResponse,
  TeamReportUser,
} from '@grind/types';
import { dateKeyInTimeZone, medianMinute, minuteOfDayInTimeZone } from '@grind/types';
import type { ReportRange } from './member';

/** When Timo started that day, as a clock reading in the workspace timezone. */
function startMinuteOf(day: MemberReportDay, tz: string): number | null {
  return day.firstActivityMs === null ? null : minuteOfDayInTimeZone(day.firstActivityMs, tz);
}

/**
 * When the day's last counted Timo time ended, as a clock reading. Work that
 * runs to midnight ends at the next day's 00:00, which reads as the last
 * minute of this day rather than as its first.
 */
function endMinuteOf(day: MemberReportDay, tz: string): number | null {
  if (day.lastActivityMs === null) return null;
  if (dateKeyInTimeZone(day.lastActivityMs, tz) !== day.date) return 24 * 60 - 1;
  return minuteOfDayInTimeZone(day.lastActivityMs, tz);
}

export function buildTeamReportsSummaryResponse(input: {
  range: ReportRange;
  users: TeamReportUser[];
  daysByUser: Map<string, MemberReportDay[]>;
  screenshotCountByUser: Map<string, number>;
}): TeamReportsSummaryResponse {
  const members = input.users.map((user) => {
    const days = input.daysByUser.get(user.id) ?? [];
    const member = buildTeamReportMember(user, days);
    return {
      user: member.user,
      workedMs: member.workedMs,
      manualMs: member.manualMs,
      invalidatedMs: member.invalidatedMs,
      activeDays: member.activeDays,
      lateDays: member.lateDays,
      onTimeDays: member.onTimeDays,
      offDays: member.offDays,
      noActivityDays: member.noActivityDays,
      gapCount: member.gapCount,
      gapMs: member.gapMs,
      approvals: member.approvals,
      screenshots: input.screenshotCountByUser.get(user.id) ?? 0,
      typicalStartMinute: medianMinute(days.map((d) => startMinuteOf(d, input.range.tz))),
      typicalEndMinute: medianMinute(days.map((d) => endMinuteOf(d, input.range.tz))),
    };
  });

  return {
    from: input.range.from,
    to: input.range.to,
    tz: input.range.tz,
    days: input.range.days,
    summary: {
      memberCount: members.length,
      workedMs: members.reduce((sum, member) => sum + member.workedMs, 0),
      manualMs: members.reduce((sum, member) => sum + member.manualMs, 0),
      invalidatedMs: members.reduce((sum, member) => sum + member.invalidatedMs, 0),
      activeDays: members.reduce((sum, member) => sum + member.activeDays, 0),
      memberDays: members.length * input.range.days.length,
      lateDays: members.reduce((sum, member) => sum + member.lateDays, 0),
      noActivityDays: members.reduce((sum, member) => sum + member.noActivityDays, 0),
      gapCount: members.reduce((sum, member) => sum + member.gapCount, 0),
      gapMs: members.reduce((sum, member) => sum + member.gapMs, 0),
      pendingApprovals: members.reduce((sum, member) => sum + member.approvals.pending, 0),
      screenshots: members.reduce((sum, member) => sum + member.screenshots, 0),
    },
    members,
  };
}

/** One person's range: totals over their days, with the days themselves. */
export function buildTeamReportMember(user: TeamReportUser, days: MemberReportDay[]): TeamReportMember {
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
    // The arrival label (Timo start), not the rules' late count — that one is
    // the month sheet's.
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
