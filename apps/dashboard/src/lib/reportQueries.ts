import type { TeamReportsSummaryResponse } from '@grind/types/reports';
import { api } from './api';

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
      return loadTeamReportSummary(params);
    },
    staleTime: TEAM_SUMMARY_STALE_MS,
    refetchOnWindowFocus: false,
  };
}

function loadTeamReportSummary(params: URLSearchParams): Promise<TeamReportsSummaryResponse> {
  return api<TeamReportsSummaryResponse>(`/v1/reports/team/summary?${params.toString()}`);
}
