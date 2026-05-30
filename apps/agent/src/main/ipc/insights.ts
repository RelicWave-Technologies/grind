import { ipcMain } from 'electron';
import { api } from '../services/apiClient';
import { log } from '../logger';

export type InsightsToday = {
  day: string;
  score: { score: number; trackedMinutes: number; engagedMinutes: number; protectedMinutes: number; idleMinutes: number };
  totals: { keystrokes: number; clicks: number; mouseDistancePx: number; scrollEvents: number };
  byHour: number[];
};

const EMPTY: InsightsToday = {
  day: new Date().toISOString().slice(0, 10),
  score: { score: 0, trackedMinutes: 0, engagedMinutes: 0, protectedMinutes: 0, idleMinutes: 0 },
  totals: { keystrokes: 0, clicks: 0, mouseDistancePx: 0, scrollEvents: 0 },
  byHour: Array.from({ length: 24 }, () => 0),
};

export type DayInsightBlock = {
  kind: 'WORK' | 'MEETING' | 'IDLE_TRIMMED' | 'MANUAL' | 'GAP';
  startedAt: number;
  endedAt: number;
  durationMs: number;
  timeEntryId?: string;
  larkTaskGuid?: string | null;
  isOpen?: boolean;
};

export type DayInsight = {
  date: string;
  timezone: string;
  dayStart: number;
  dayEnd: number;
  isFuture: boolean;
  isToday: boolean;
  firstActivityAt: number | null;
  lastActivityAt: number | null;
  totals: { workedMs: number; meetingMs: number; manualMs: number; idleTrimmedMs: number; gapMs: number };
  blocks: DayInsightBlock[];
  pendingOverlay: Array<{ id: string; startedAt: number; endedAt: number; reason: string; larkTaskGuid: string | null }>;
  recentRejected: Array<{ id: string; requestedStart: number; requestedEnd: number; reason: string; decidedReason: string | null; larkTaskGuid: string | null }>;
};

const EMPTY_DAY: DayInsight = {
  date: new Date().toISOString().slice(0, 10),
  timezone: 'UTC',
  dayStart: 0,
  dayEnd: 0,
  isFuture: false,
  isToday: true,
  firstActivityAt: null,
  lastActivityAt: null,
  totals: { workedMs: 0, meetingMs: 0, manualMs: 0, idleTrimmedMs: 0, gapMs: 0 },
  blocks: [],
  pendingOverlay: [],
  recentRejected: [],
};

/** Today's productivity score + activity totals, from the backend insights endpoint. */
export function registerInsightsIpc(): void {
  ipcMain.handle('insights:today', async (): Promise<InsightsToday> => {
    try {
      return await api<InsightsToday>('/v1/insights/score');
    } catch (err) {
      log.warn('insights:today failed', { err: String(err) });
      return EMPTY;
    }
  });

  // Per-day blocks for the Edit Time tab. The renderer passes the resolved
  // IANA timezone so the backend's day-window math stays user-local. We race
  // against a 12s timeout so a hung backend never leaves the renderer stuck
  // on a perpetual spinner — the UI surfaces an error + retry instead.
  ipcMain.handle('insights:day', async (_e, args: { date: string; tz: string }): Promise<DayInsight> => {
    try {
      const q = new URLSearchParams({ date: args.date, tz: args.tz });
      const fetchPromise = api<DayInsight>(`/v1/insights/day?${q.toString()}`);
      const timeoutPromise = new Promise<DayInsight>((_, reject) =>
        setTimeout(() => reject(new Error('insights:day timeout (12s)')), 12_000),
      );
      return await Promise.race([fetchPromise, timeoutPromise]);
    } catch (err) {
      log.warn('insights:day failed', { err: String(err), date: args.date });
      throw err; // let the renderer's TanStack Query surface the error
    }
  });
}
