export interface WorkspaceTimeContext {
  ready: boolean;
  timeZone: string | null;
  source: 'server' | 'cache' | 'unavailable';
  date: string | null;
  dayStart: number | null;
  dayEnd: number | null;
}
