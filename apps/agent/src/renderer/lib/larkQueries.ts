import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

/**
 * The Lark status and task-list queries, shared by every screen that polls
 * them. Each `lark:tasks` call makes the server call Lark and load the full
 * timeline, and Settings used to ask for the status every 4 seconds, so the
 * polls are slow by design. What makes the list feel live instead: a refresh
 * whenever the window comes back into focus, a manual Sync (SyncButton seeds
 * the cache), and a connect/disconnect push from the main process.
 */
export const LARK_STATUS_POLL_MS = 60_000;
export const LARK_TASKS_POLL_MS = 5 * 60_000;

export function useLarkStatus() {
  return useQuery({
    queryKey: ['larkStatus'],
    queryFn: () => window.agent.lark.status(),
    refetchInterval: LARK_STATUS_POLL_MS,
    refetchOnWindowFocus: true,
  });
}

export function useLarkTasks() {
  return useQuery({
    queryKey: ['larkTasks'],
    queryFn: () => window.agent.lark.tasks(),
    refetchInterval: LARK_TASKS_POLL_MS,
    refetchOnWindowFocus: true,
  });
}

/** Refetch both as soon as a Lark connection is made or lost. */
export function useLarkConnectionRefresh(): void {
  const qc = useQueryClient();
  useEffect(() => {
    return window.agent.lark.onConnectionChange(() => {
      void qc.invalidateQueries({ queryKey: ['larkStatus'] });
      void qc.invalidateQueries({ queryKey: ['larkTasks'] });
    });
  }, [qc]);
}
