import { keepPreviousData, queryOptions, type FetchQueryOptions, type QueryClient } from '@tanstack/react-query';
import type { TeamReportsSummaryResponse } from '@grind/types/reports';
import { api } from './api';

/**
 * Query options for every page's first-paint data — the ONE place a query's
 * key, endpoint and cache policy live.
 *
 * Screens call `useQuery(xQuery<Response>(…))` (spreading in screen-only
 * options such as `enabled` or a live `refetchInterval`). Route loaders in
 * router.tsx call `prefetch(…)` with the very same factories, so a page's data
 * request starts on nav-link hover / route load — in parallel with the page's
 * code chunk — instead of only after the component mounts. Same factory, same
 * key: the mounted `useQuery` picks up the in-flight request.
 *
 * The response type stays with the screen that renders it (the generic `T`);
 * like `api<T>`, it is an unchecked cast, so a loader can prefetch without
 * importing screen code.
 *
 * Cache policy (QueryClient defaults in main.tsx: 30s staleTime):
 *   - REFERENCE — lists that change only through admin edits (teams, shifts,
 *     the workspace directory). Their mutations invalidate explicitly, so 5 min
 *     of freshness just stops a refetch on every page visit.
 *   - RANGE — date-range lists whose rows carry their own dates (a day per
 *     row or column) keep the previous range on screen while the next loads,
 *     instead of flashing back to a skeleton. Not used where the period is
 *     only named by the UI (month totals, the leave month grid): there, stale
 *     numbers under the new label would mislead, so those keep the skeleton.
 */

const REFERENCE = { staleTime: 5 * 60_000 } as const;
const RANGE = { placeholderData: keepPreviousData };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any factory's options, whatever its data type
type AnyQueryOptions = FetchQueryOptions<any, any, any, any>;

/** Fire-and-forget prefetch for route loaders. Never blocks navigation: the
 *  page renders its own skeletons and adopts the in-flight request. Respects
 *  each query's staleTime, so hovering a link twice costs one request. */
export function prefetch(queryClient: QueryClient, ...queries: AnyQueryOptions[]): void {
  for (const query of queries) void queryClient.prefetchQuery(query);
}

const qs = (params: Record<string, string>) => new URLSearchParams(params).toString();

// ── Today / Team today ──────────────────────────────────────────────────────

export function overviewQuery<T = unknown>(tz: string) {
  return queryOptions({
    queryKey: ['admin', 'overview', tz],
    queryFn: () => api<T>(`/v1/admin/overview?${qs({ tz })}`),
  });
}

/** The signed-in user's own day (Home). */
export function myDayQuery<T = unknown>(input: { date: string; tz: string; userId: string }) {
  return queryOptions({
    queryKey: ['insights', 'day', input.date, input.tz, input.userId],
    queryFn: () => api<T>(`/v1/insights/day?${qs({ date: input.date, tz: input.tz })}`),
  });
}

export function myPendingTimeRequestsQuery<T = unknown>(userId: string) {
  return queryOptions({
    queryKey: ['time-requests', 'mine', 'PENDING', userId],
    queryFn: () => api<T>('/v1/time-requests?role=mine&status=PENDING'),
    retry: false,
  });
}

/** A user-day on Edit Time, with gaps measured across the calendar day. */
export function editTimeDayQuery<T = unknown>(input: { date: string; tz: string; userId: string; meId: string }) {
  return queryOptions({
    queryKey: ['insights', 'day', input.date, input.tz, input.userId, 'calendar-day-gaps'],
    queryFn: () => {
      const params = new URLSearchParams({ date: input.date, tz: input.tz, gapScope: 'calendar-day' });
      if (input.userId !== input.meId) params.set('userId', input.userId);
      return api<T>(`/v1/insights/day?${params.toString()}`);
    },
  });
}

/** The caller's Lark tasks. Falls back to an empty list when Lark isn't set up. */
export function larkMyTasksQuery<T extends { tasks: unknown[] } = { tasks: unknown[] }>() {
  return queryOptions({
    queryKey: ['lark', 'my-tasks'],
    queryFn: async (): Promise<T> => {
      try {
        return await api<T>('/v1/lark/my-tasks');
      } catch {
        return { tasks: [] } as unknown as T;
      }
    },
    ...REFERENCE,
    retry: false,
  });
}

// ── Reports ─────────────────────────────────────────────────────────────────

const TEAM_SUMMARY_STALE_MS = 5 * 60_000;

export const reportQueryKeys = {
  teamSummaryRoot: ['reports', 'team-summary'] as const,
  teamSummary: (input: { from: string; to: string; tz: string; teamId?: string }) => [
    ...reportQueryKeys.teamSummaryRoot,
    input.from,
    input.to,
    input.tz,
    input.teamId ?? null,
  ] as const,
};

export function teamReportSummaryQuery(input: { from: string; to: string; tz: string; teamId?: string }) {
  return queryOptions({
    queryKey: reportQueryKeys.teamSummary(input),
    queryFn: () => {
      const params = new URLSearchParams({ from: input.from, to: input.to, tz: input.tz });
      if (input.teamId) params.set('teamId', input.teamId);
      return api<TeamReportsSummaryResponse>(`/v1/reports/team/summary?${params.toString()}`);
    },
    staleTime: TEAM_SUMMARY_STALE_MS,
    refetchOnWindowFocus: false,
  });
}

export function myReportQuery<T = unknown>(input: { from: string; to: string; tz: string }) {
  return queryOptions({
    queryKey: ['reports', 'me', input.from, input.to, input.tz],
    queryFn: () => api<T>(`/v1/reports/me?${qs(input)}`),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    ...RANGE,
  });
}

// ── Approvals ───────────────────────────────────────────────────────────────

export function myApprovalsQuery<T = unknown>(input: { from: string; to: string; tz: string }) {
  return queryOptions({
    queryKey: ['approvals', 'you', input.from, input.to, input.tz],
    queryFn: () => api<T>(`/v1/time-requests?${qs({ role: 'mine', ...input })}`),
    ...RANGE,
  });
}

export function teamApprovalsQuery<T = unknown>(input: { from: string; to: string; tz: string }) {
  return queryOptions({
    queryKey: ['approvals', 'team', input.from, input.to, input.tz],
    queryFn: () => api<T>(`/v1/admin/manual-time-requests?${qs({ status: 'ALL', ...input })}`),
    ...RANGE,
  });
}

// ── Attendance ──────────────────────────────────────────────────────────────

export function attendanceQuery<T = unknown>(input: { from: string; to: string; tz: string }) {
  return queryOptions({
    queryKey: ['admin', 'attendance', input.from, input.to, input.tz],
    queryFn: () => api<T>(`/v1/admin/timesheets?${qs(input)}`),
    ...RANGE,
  });
}

export function monthSummaryQuery<T = unknown>(month: string) {
  return queryOptions({
    queryKey: ['admin', 'month-summary', month],
    queryFn: () => api<T>(`/v1/reports/month-summary?${qs({ month })}`),
    retry: false,
  });
}

/** The month performance sheet as data — the Excel grid, drawn on Reports. */
export function monthSheetQuery<T = unknown>(month: string) {
  return queryOptions({
    queryKey: ['reports', 'month-sheet', month],
    queryFn: () => api<T>(`/v1/reports/month-sheet?${qs({ month })}`),
    retry: false,
  });
}

// ── Leave calendar ──────────────────────────────────────────────────────────

/** Leave and holidays for a date range — the Calendar asks for one month (`monthBounds`). */
export function leaveCalendarQuery<T = unknown>({ from, to }: { from: string; to: string }) {
  return queryOptions({
    queryKey: ['leave', 'calendar', from, to],
    queryFn: () => api<T>(`/v1/leave/calendar?${qs({ from, to })}`),
  });
}

export function leaveBalanceQuery<T = unknown>() {
  return queryOptions({ queryKey: ['leave', 'balance'], queryFn: () => api<T>('/v1/leave/me/balance') });
}

export function leavePolicyQuery<T = unknown>() {
  return queryOptions({ queryKey: ['leave', 'policy'], queryFn: () => api<T>('/v1/leave/policy'), ...REFERENCE });
}

export function myLeaveRequestsQuery<T = unknown>() {
  return queryOptions({ queryKey: ['leave', 'me', 'requests'], queryFn: () => api<T>('/v1/leave/me/requests') });
}

// ── People & admin lists ────────────────────────────────────────────────────

/** Every screen that lists people shares this cache entry (People, Teams,
 *  Shifts, the Edit Time picker). Deactivated users are a separate entry. */
export function adminUsersQuery<T = unknown>(opts: { includeDeactivated?: boolean } = {}) {
  return queryOptions({
    queryKey: opts.includeDeactivated ? ['admin', 'users', 'with-deactivated'] : ['admin', 'users'],
    queryFn: () => api<T>(opts.includeDeactivated ? '/v1/admin/users?includeDeactivated=true' : '/v1/admin/users'),
  });
}

export function adminTeamsQuery<T = unknown>() {
  return queryOptions({ queryKey: ['admin', 'teams'], queryFn: () => api<T>('/v1/admin/teams'), ...REFERENCE });
}

export function adminShiftsQuery<T = unknown>() {
  return queryOptions({ queryKey: ['admin', 'shifts'], queryFn: () => api<T>('/v1/admin/shifts'), ...REFERENCE });
}

/** Workspace directory (any signed-in user) for attendee pickers. */
export function workspaceUsersQuery<T = unknown>() {
  return queryOptions({ queryKey: ['workspace', 'users'], queryFn: () => api<T>('/v1/workspace/users'), ...REFERENCE });
}

export function profileQuery<T = unknown>() {
  return queryOptions({ queryKey: ['profile', 'me'], queryFn: () => api<T>('/v1/profile/me') });
}

export function flagGroupsQuery<T = unknown>(status: 'OPEN' | 'RESOLVED') {
  return queryOptions({
    queryKey: ['admin', 'flags', 'groups', status],
    queryFn: () => api<T>(`/v1/admin/flags/groups?${qs({ status })}`),
  });
}

export function apiTokensQuery<T = unknown>() {
  return queryOptions({ queryKey: ['admin', 'api-tokens'], queryFn: () => api<T>('/v1/admin/api-tokens') });
}

// ── Settings ────────────────────────────────────────────────────────────────

/** Policy page's copy of the workspace policy. Team settings reads the same
 *  endpoint under `teamWorkspacePolicyQuery`; Policy's save refreshes both. */
export function workspacePolicyQuery<T = unknown>() {
  return queryOptions({ queryKey: ['workspace-policy'], queryFn: () => api<T>('/v1/admin/workspace-policy') });
}

export function accessRequestRecipientsQuery<T = unknown>() {
  return queryOptions({
    queryKey: ['admin', 'access-request-recipients'],
    queryFn: () => api<T>('/v1/admin/access-requests/recipients'),
  });
}

export function teamWorkspacePolicyQuery<T = unknown>() {
  return queryOptions({ queryKey: ['admin', 'workspace-policy'], queryFn: () => api<T>('/v1/admin/workspace-policy') });
}

export function monitoringAuditsQuery<T = unknown>() {
  return queryOptions({
    queryKey: ['admin', 'monitoring-settings-audits'],
    queryFn: () => api<T>('/v1/admin/monitoring-settings-audits?limit=20'),
  });
}

export function adminLeavePolicyQuery<T = unknown>() {
  return queryOptions({ queryKey: ['admin', 'leave-policy'], queryFn: () => api<T>('/v1/admin/leave/policy') });
}

export const TEAM_SETTINGS_QUERY_KEY = ['admin', 'team-member-settings'] as const;

export function teamMemberSettingsQuery<T = unknown>() {
  return queryOptions({ queryKey: TEAM_SETTINGS_QUERY_KEY, queryFn: () => api<T>('/v1/admin/team-member-settings') });
}
