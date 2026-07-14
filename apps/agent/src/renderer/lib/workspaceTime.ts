import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { instantForZonedDateTime } from '@grind/types';
import type { WorkspaceTimeContext } from '../../shared/workspaceTime';

export const WORKSPACE_TIME_QUERY_KEY = ['workspaceTime'] as const;

export function useWorkspaceTime() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: WORKSPACE_TIME_QUERY_KEY,
    queryFn: () => window.agent.workspaceTime.get(),
    staleTime: 60_000,
  });

  useEffect(() => window.agent.workspaceTime.onChange((context) => {
    queryClient.setQueryData(WORKSPACE_TIME_QUERY_KEY, context);
  }), [queryClient]);

  return query;
}

export function formatWorkspaceTime(value: number, timeZone: string | null): string {
  if (!timeZone) return '--';
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(value));
}

export function formatWorkspaceDate(value: number, timeZone: string | null): string {
  if (!timeZone) return '--';
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    month: 'short',
    day: 'numeric',
  }).format(new Date(value));
}

export function formatWorkspaceDateTime(value: number, timeZone: string | null): string {
  if (!timeZone) return '--';
  return new Intl.DateTimeFormat(undefined, {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

export function localDateAtHour(date: string, hour: number, timeZone: string): number {
  const [year, month, day] = date.split('-').map((part) => Number.parseInt(part, 10));
  return instantForZonedDateTime({
    year: year!,
    month: month!,
    day: day!,
    hour,
    minute: 0,
    second: 0,
  }, timeZone).getTime();
}

export function workspaceTimeReady(context: WorkspaceTimeContext | undefined): context is WorkspaceTimeContext & {
  ready: true;
  timeZone: string;
  date: string;
  dayStart: number;
  dayEnd: number;
} {
  return Boolean(
    context?.ready
      && context.timeZone
      && context.date
      && context.dayStart !== null
      && context.dayEnd !== null,
  );
}
