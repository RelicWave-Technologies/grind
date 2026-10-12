import type { QueryClient } from '@tanstack/react-query';
import { hasCapability, type Me } from './auth';
import {
  adminLeavePolicyQuery,
  adminShiftsQuery,
  adminTeamsQuery,
  adminUsersQuery,
  apiTokensQuery,
  attendanceQuery,
  editTimeDayQuery,
  flagGroupsQuery,
  larkMyTasksQuery,
  leaveBalanceQuery,
  leaveCalendarQuery,
  leavePolicyQuery,
  monitoringAuditsQuery,
  monthSummaryQuery,
  myApprovalsQuery,
  myDayQuery,
  myLeaveRequestsQuery,
  myPendingTimeRequestsQuery,
  myReportQuery,
  overviewQuery,
  prefetch,
  profileQuery,
  teamApprovalsQuery,
  teamMemberSettingsQuery,
  teamReportSummaryQuery,
  teamWorkspacePolicyQuery,
  workspacePolicyQuery,
} from './queries';

/**
 * What each page reads on first paint, for the route loaders in router.tsx.
 * Arguments mirror each screen's initial state (Reports/Approvals open on the
 * last 7 days, Attendance on this month + a 14-day grid, …) so the prefetched
 * entry is exactly the one the screen's `useQuery` asks for.
 *
 * Loaded on demand (router.tsx imports it dynamically). The date helpers
 * come from lib/format → @grind/types (and zod), so they're imported only by
 * the pages that need a date — the same chunk those screens load anyway —
 * keeping them out of the entry chunk and off pages like People.
 */

export interface RouteSearch {
  date?: string;
  userId?: string;
}

type PagePrefetch = (queryClient: QueryClient, me: Me, search: RouteSearch) => void | Promise<void>;

const dates = () => import('./format');

async function lastWeek(tz: string) {
  const { addDays, todayKey } = await dates();
  const to = todayKey(tz);
  return { from: addDays(to, -6), to, tz };
}

export const pagePrefetch = {
  home: async (qc, me) => {
    const { todayKey } = await dates();
    const tz = me.workspaceTimezone;
    prefetch(qc, myDayQuery({ date: todayKey(tz), tz, userId: me.id }), myPendingTimeRequestsQuery(me.id));
  },
  overview: (qc, me) => prefetch(qc, overviewQuery(me.workspaceTimezone)),
  editTime: async (qc, me, search) => {
    const { todayKey } = await dates();
    const tz = me.workspaceTimezone;
    // Same defaults as MeTodayScreen: a valid ?date else today, ?userId else self.
    const date = search.date && /^\d{4}-\d{2}-\d{2}$/.test(search.date) ? search.date : todayKey(tz);
    prefetch(
      qc,
      editTimeDayQuery({ date, tz, userId: search.userId || me.id, meId: me.id }),
      larkMyTasksQuery(),
      ...(me.role !== 'MEMBER' ? [adminUsersQuery()] : []),
    );
  },
  reports: async (qc, me) => {
    const range = await lastWeek(me.workspaceTimezone);
    prefetch(qc, hasCapability(me, 'reports.team.read') ? teamReportSummaryQuery(range) : myReportQuery(range));
  },
  approvals: async (qc, me) => {
    const range = await lastWeek(me.workspaceTimezone);
    const canReview = hasCapability(me, 'approvals.team.decide') || hasCapability(me, 'approvals.workspace.decide');
    if (canReview) prefetch(qc, teamApprovalsQuery(range));
    else prefetch(qc, myApprovalsQuery(range), larkMyTasksQuery());
  },
  attendance: async (qc, me) => {
    const { addDays, todayKey } = await dates();
    const tz = me.workspaceTimezone;
    const today = todayKey(tz);
    prefetch(qc, monthSummaryQuery(today.slice(0, 7)), attendanceQuery({ from: addDays(today, -13), to: today, tz }));
  },
  calendar: async (qc, me) => {
    const { monthBounds, todayKey } = await dates();
    prefetch(
      qc,
      leaveCalendarQuery(monthBounds(todayKey(me.workspaceTimezone).slice(0, 7))),
      leaveBalanceQuery(),
      leavePolicyQuery(),
      myLeaveRequestsQuery(),
    );
  },
  profile: (qc) => prefetch(qc, profileQuery()),
  users: (qc, me) =>
    prefetch(qc, adminUsersQuery(), ...(me.role === 'ADMIN' ? [adminTeamsQuery(), adminShiftsQuery()] : [])),
  team: (qc) => prefetch(qc, teamMemberSettingsQuery(), teamWorkspacePolicyQuery()),
  teams: (qc) => prefetch(qc, adminTeamsQuery(), adminUsersQuery()),
  shifts: (qc) => prefetch(qc, adminShiftsQuery(), adminUsersQuery()),
  flags: (qc) => prefetch(qc, flagGroupsQuery('OPEN')),
  policy: (qc) => prefetch(qc, workspacePolicyQuery(), monitoringAuditsQuery(), adminLeavePolicyQuery()),
  integrations: (qc) => prefetch(qc, apiTokensQuery()),
} satisfies Record<string, PagePrefetch>;

export type PrefetchPage = keyof typeof pagePrefetch;
