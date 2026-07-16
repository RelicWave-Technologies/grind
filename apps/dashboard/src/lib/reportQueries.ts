import type { TeamReportsResponse, TeamReportsSummaryResponse } from '@grind/types/reports';
import { api, ApiError } from './api';

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

export function teamReportSummaryQuery(input: {
  from: string;
  to: string;
  tz: string;
  teamId?: string;
}) {
  return {
    queryKey: reportQueryKeys.teamSummary(input),
    queryFn: () => {
      const params = new URLSearchParams({ from: input.from, to: input.to, tz: input.tz });
      if (input.teamId) params.set('teamId', input.teamId);
      return loadTeamReportSummary(params, Boolean(input.teamId));
    },
    staleTime: TEAM_SUMMARY_STALE_MS,
    refetchOnWindowFocus: false,
  };
}

async function loadTeamReportSummary(params: URLSearchParams, hasTeamFilter: boolean): Promise<TeamReportsSummaryResponse> {
  try {
    return await api<TeamReportsSummaryResponse>(`/v1/reports/team/summary?${params.toString()}`);
  } catch (error) {
    // Allows the dashboard image to roll forward before the API image. A
    // team-filtered request cannot safely fall back because the legacy route
    // does not understand teamId and would load the whole workspace.
    if (!(error instanceof ApiError) || error.status !== 404 || hasTeamFilter) throw error;
    const legacy = await api<TeamReportsResponse>(`/v1/reports/team?${params.toString()}`);
    return {
      from: legacy.from,
      to: legacy.to,
      tz: legacy.tz,
      days: legacy.days,
      summary: {
        memberCount: legacy.summary.memberCount,
        workedMs: legacy.summary.workedMs,
        manualMs: legacy.summary.manualMs,
        invalidatedMs: legacy.summary.invalidatedMs,
        activeDays: legacy.summary.activeDays,
        memberDays: legacy.summary.memberDays,
        lateDays: legacy.summary.lateDays,
        noActivityDays: legacy.summary.noActivityDays,
        gapCount: legacy.summary.gapCount,
        gapMs: legacy.summary.gapMs,
        pendingApprovals: legacy.summary.pendingApprovals,
        screenshots: legacy.summary.screenshots,
      },
      members: legacy.members.map((member) => ({
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
        screenshots: member.screenshots,
      })),
    };
  }
}
