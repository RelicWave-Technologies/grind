import { contextBridge, ipcRenderer } from 'electron';
import type { UserDto } from '@grind/types';

type AuthStatus = 'loggedIn' | 'loggedOut';
type AgentStatus = { state: 'IDLE' | 'OFFLINE'; lastHeartbeatAt: string | null };
type TimerStatus =
  | { state: 'IDLE' }
  | { state: 'RUNNING'; entryId: string; larkTaskGuid: string | null; startedAt: number; workedMs: number; paused: boolean };
type TodaySegment = { kind: 'WORK' | 'MEETING' | 'IDLE_TRIMMED'; startedAt: number; endedAt: number | null };
type TodayEntry = { id: string; larkTaskGuid: string | null; segments: TodaySegment[] };

const api = {
  auth: {
    login: (email: string, password: string): Promise<UserDto> =>
      ipcRenderer.invoke('auth:login', { email, password }),
    logout: (): Promise<{ ok: true }> => ipcRenderer.invoke('auth:logout'),
    status: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:status'),
    onStatusChange: (cb: (s: AuthStatus) => void): (() => void) => {
      const sub = (_e: unknown, s: AuthStatus) => cb(s);
      ipcRenderer.on('auth:status:push', sub);
      return () => {
        ipcRenderer.off('auth:status:push', sub);
      };
    },
  },
  agent: {
    status: (): Promise<AgentStatus> => ipcRenderer.invoke('agent:status'),
  },
  timer: {
    start: (larkTaskGuid?: string | null): Promise<TimerStatus> =>
      ipcRenderer.invoke('timer:start', { larkTaskGuid }),
    stop: (): Promise<TimerStatus> => ipcRenderer.invoke('timer:stop'),
    status: (): Promise<TimerStatus> => ipcRenderer.invoke('timer:status'),
    today: (): Promise<TodayEntry[]> => ipcRenderer.invoke('timer:today'),
    onStatusChange: (cb: (s: TimerStatus) => void): (() => void) => {
      const sub = (_e: unknown, s: TimerStatus) => cb(s);
      ipcRenderer.on('timer:status:push', sub);
      return () => {
        ipcRenderer.off('timer:status:push', sub);
      };
    },
    patchEntry: (args: { id: string; larkTaskGuid?: string | null; notes?: string | null }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('timer:patchEntry', args),
  },
  window: {
    openMain: (): Promise<void> => ipcRenderer.invoke('window:openMain'),
  },
  idle: {
    get: (): Promise<{ idleStartedAt: number }> => ipcRenderer.invoke('idle:get'),
    resolve: (action: 'continue' | 'break'): Promise<void> => ipcRenderer.invoke('idle:resolve', action),
  },
  screenshots: {
    recent: (limit?: number): Promise<{ id: string; capturedAt: number; thumb: string | null; uploadState: string; keyboardPct: number; mousePct: number }[]> =>
      ipcRenderer.invoke('screenshots:recent', limit),
    countToday: (): Promise<number> => ipcRenderer.invoke('screenshots:countToday'),
    captureOnce: (): Promise<number> => ipcRenderer.invoke('screenshots:captureOnce'),
    full: (id: string): Promise<string | null> => ipcRenderer.invoke('screenshots:full', id),
  },
  permissions: {
    screen: (): Promise<{ status: string; health: string; state: 'ok' | 'needs-grant' | 'needs-settings' | 'needs-restart' }> =>
      ipcRenderer.invoke('permissions:screen'),
    accessibility: (): Promise<{ trusted: boolean; capturing: boolean }> => ipcRenderer.invoke('permissions:accessibility'),
    requestAccessibility: (): Promise<void> => ipcRenderer.invoke('permissions:requestAccessibility'),
  },
  settings: {
    get: (): Promise<{ version: string; platform: string; launchAtLogin: boolean; screenStatus: string }> =>
      ipcRenderer.invoke('settings:get'),
    setLaunchAtLogin: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('settings:setLaunchAtLogin', enabled),
    openScreenPrefs: (): Promise<void> => ipcRenderer.invoke('settings:openScreenPrefs'),
    openDataFolder: (): Promise<void> => ipcRenderer.invoke('settings:openDataFolder'),
  },
  app: {
    relaunch: (): Promise<void> => ipcRenderer.invoke('app:relaunch'),
  },
  insights: {
    today: (): Promise<{
      day: string;
      score: { score: number; trackedMinutes: number; engagedMinutes: number; protectedMinutes: number; idleMinutes: number };
      totals: { keystrokes: number; clicks: number; mouseDistancePx: number; scrollEvents: number };
      byHour: number[];
    }> => ipcRenderer.invoke('insights:today'),
    day: (args: { date: string; tz: string }): Promise<DayInsightBridge> =>
      ipcRenderer.invoke('insights:day', args),
  },
  lark: {
    status: (): Promise<{ configured: boolean; connected: boolean; reauthRequired: boolean; scopes: string[] }> =>
      ipcRenderer.invoke('lark:status'),
    connect: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('lark:connect'),
    disconnect: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('lark:disconnect'),
    tasks: (): Promise<{ tasks: { guid: string; summary: string; completed: boolean; url?: string; due: number | null; createdAt: number | null; creatorId: string | null; creatorName: string | null; loggedMs: number }[]; reauthRequired: boolean }> =>
      ipcRenderer.invoke('lark:tasks'),
    createTask: (input: { summary: string; due?: number | null; description?: string | null }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('lark:createTask', input),
  },
  timeRequests: {
    create: (input: {
      requestedStart: number;
      requestedEnd: number;
      reason: string;
      larkTaskGuid?: string | null;
      taskSummary?: string | null;
    }): Promise<{
      ok: boolean;
      request?: ManualTimeRequestDto;
      error?: string;
    }> => ipcRenderer.invoke('timeRequests:create', input),
    listMine: (status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'): Promise<{ requests: ManualTimeRequestDto[] }> =>
      ipcRenderer.invoke('timeRequests:listMine', status),
    patch: (args: {
      id: string;
      requestedStart?: number;
      requestedEnd?: number;
      larkTaskGuid?: string | null;
      taskSummary?: string | null;
      reason?: string;
    }): Promise<{ ok: boolean; request?: ManualTimeRequestDto; error?: string }> =>
      ipcRenderer.invoke('timeRequests:patch', args),
    cancel: (id: string): Promise<{ ok: boolean; request?: ManualTimeRequestDto; error?: string }> =>
      ipcRenderer.invoke('timeRequests:cancel', id),
  },
};

type DayInsightBridge = {
  date: string;
  timezone: string;
  dayStart: number;
  dayEnd: number;
  isFuture: boolean;
  isToday: boolean;
  firstActivityAt: number | null;
  lastActivityAt: number | null;
  totals: { workedMs: number; meetingMs: number; manualMs: number; idleTrimmedMs: number; gapMs: number };
  blocks: Array<{
    kind: 'WORK' | 'MEETING' | 'IDLE_TRIMMED' | 'MANUAL' | 'GAP';
    startedAt: number;
    endedAt: number;
    durationMs: number;
    timeEntryId?: string;
    larkTaskGuid?: string | null;
    notes?: string | null;
    isOpen?: boolean;
  }>;
  pendingOverlay: Array<{ id: string; startedAt: number; endedAt: number; reason: string; larkTaskGuid: string | null }>;
  recentRejected: Array<{
    id: string;
    requestedStart: number;
    requestedEnd: number;
    reason: string;
    decidedReason: string | null;
    larkTaskGuid: string | null;
  }>;
};

type ManualTimeRequestDto = {
  id: string;
  clientUuid: string;
  userId: string;
  approverId: string | null;
  larkTaskGuid: string | null;
  larkMessageId: string | null;
  requestedStart: string;
  requestedEnd: string;
  reason: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  decidedAt: string | null;
  decidedReason: string | null;
  createdAt: string;
};

contextBridge.exposeInMainWorld('agent', api);

export type AgentBridge = typeof api;
