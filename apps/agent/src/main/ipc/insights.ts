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
}
