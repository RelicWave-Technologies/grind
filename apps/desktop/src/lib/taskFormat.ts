/** Shared formatting for Lark task cards (used by Today + Tasks screens). */
import { dateKeyInTimeZone } from '@grind/types';
import { formatWorkspaceDate } from './workspaceTime';

export function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60000);
  if (m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h}h ${r}m` : `${h}h`;
}

export function fmtDate(ms: number, timeZone: string | null): string {
  return formatWorkspaceDate(ms, timeZone);
}

export type DueInfo = { label: string; tone: 'overdue' | 'soon' | 'normal' };
export function dueInfo(due: number, now: number, timeZone: string): DueInfo {
  const day = 86_400_000;
  const ordinal = (value: number) => {
    const [year, month, date] = dateKeyInTimeZone(value, timeZone)
      .split('-')
      .map((part) => Number.parseInt(part, 10));
    return Date.UTC(year!, month! - 1, date!);
  };
  const diff = Math.round((ordinal(due) - ordinal(now)) / day);
  if (diff < 0) return { label: `Overdue ${-diff}d`, tone: 'overdue' };
  if (diff === 0) return { label: 'Due today', tone: 'soon' };
  if (diff === 1) return { label: 'Due tomorrow', tone: 'soon' };
  if (diff < 7) return { label: `Due in ${diff}d`, tone: 'normal' };
  return { label: `Due ${formatWorkspaceDate(due, timeZone)}`, tone: 'normal' };
}

export type LarkTaskItem = {
  guid: string;
  summary: string;
  completed: boolean;
  url?: string;
  due: number | null;
  createdAt: number | null;
  creatorId: string | null;
  creatorName: string | null;
  loggedMs: number;
  loggedTodayMs?: number;
  loggedTotalMs?: number;
};

/** Sort: running first, then due (soonest), newest-created, most-tracked, name. */
export function sortTasks(tasks: LarkTaskItem[], runningGuid: string | null): LarkTaskItem[] {
  return [...tasks].sort((a, b) => {
    if (runningGuid) {
      if (a.guid === runningGuid) return -1;
      if (b.guid === runningGuid) return 1;
    }
    const ad = a.due ?? Infinity;
    const bd = b.due ?? Infinity;
    if (ad !== bd) return ad - bd;
    const ac = a.createdAt ?? 0;
    const bc = b.createdAt ?? 0;
    if (bc !== ac) return bc - ac;
    const at = a.loggedTodayMs ?? a.loggedMs;
    const bt = b.loggedTodayMs ?? b.loggedMs;
    if (bt !== at) return bt - at;
    return a.summary.localeCompare(b.summary);
  });
}
