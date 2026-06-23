import { contextBridge, ipcRenderer } from 'electron';
import type { UserDto } from '@grind/types';

type AuthStatus = 'loggedIn' | 'loggedOut';
type LarkOutcome = { kind: 'pending' } | { kind: 'error'; reason: string };
type AgentStatus = { state: 'IDLE' | 'OFFLINE'; lastHeartbeatAt: string | null };
type TimerStatus =
  | { state: 'IDLE'; workedMs: number }
  | { state: 'RUNNING'; entryId: string; larkTaskGuid: string | null; startedAt: number; workedMs: number; paused: boolean };
type TodaySegment = { kind: 'WORK' | 'MEETING' | 'IDLE_TRIMMED'; startedAt: number; endedAt: number | null };
type TodayEntry = { id: string; larkTaskGuid: string | null; segments: TodaySegment[] };
type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'not-available' | 'error';
type UpdateStatus = {
  phase: UpdatePhase;
  enabled: boolean;
  currentVersion: string;
  channel: 'latest' | 'beta';
  availableVersion: string | null;
  percent: number | null;
  error: string | null;
  checkedAt: number | null;
  readyAt: number | null;
  manual: boolean;
  canInstallNow: boolean;
};

const api = {
  auth: {
    login: (email: string, password: string): Promise<UserDto> =>
      ipcRenderer.invoke('auth:login', { email, password }),
    loginWithLark: (): Promise<{ ok: true }> => ipcRenderer.invoke('auth:loginWithLark'),
    logout: (): Promise<{ ok: true }> => ipcRenderer.invoke('auth:logout'),
    status: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:status'),
    me: (): Promise<{ name: string; avatarUrl: string | null } | null> => ipcRenderer.invoke('auth:me'),
    onStatusChange: (cb: (s: AuthStatus) => void): (() => void) => {
      const sub = (_e: unknown, s: AuthStatus) => cb(s);
      ipcRenderer.on('auth:status:push', sub);
      return () => {
        ipcRenderer.off('auth:status:push', sub);
      };
    },
    // Non-success Lark outcomes (pending approval / error) pushed from main.
    onLarkOutcome: (cb: (o: LarkOutcome) => void): (() => void) => {
      const sub = (_e: unknown, o: LarkOutcome) => cb(o);
      ipcRenderer.on('auth:lark:push', sub);
      return () => {
        ipcRenderer.off('auth:lark:push', sub);
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
  },
  window: {
    openMain: (): Promise<void> => ipcRenderer.invoke('window:openMain'),
  },
  idle: {
    get: (): Promise<{ idleStartedAt: number }> => ipcRenderer.invoke('idle:get'),
    resolve: (action: 'continue' | 'break'): Promise<void> => ipcRenderer.invoke('idle:resolve', action),
  },
  shift: {
    decide: (decision: 'yes' | 'not_yet'): Promise<void> => ipcRenderer.invoke('shift:decide', decision),
    refresh: (): Promise<void> => ipcRenderer.invoke('shift:refresh'),
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
    get: (): Promise<{ version: string; platform: string; launchAtLogin: boolean; screenStatus: string; floatingBarVisible: boolean }> =>
      ipcRenderer.invoke('settings:get'),
    setLaunchAtLogin: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('settings:setLaunchAtLogin', enabled),
    setFloatingBarVisible: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('settings:setFloatingBarVisible', enabled),
    resetFloatingBarPosition: (): Promise<void> => ipcRenderer.invoke('settings:resetFloatingBarPosition'),
    openScreenPrefs: (): Promise<void> => ipcRenderer.invoke('settings:openScreenPrefs'),
    openDataFolder: (): Promise<void> => ipcRenderer.invoke('settings:openDataFolder'),
  },
  app: {
    relaunch: (): Promise<void> => ipcRenderer.invoke('app:relaunch'),
    openDashboard: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('app:openDashboard'),
  },
  updates: {
    status: (): Promise<UpdateStatus> => ipcRenderer.invoke('updates:status'),
    checkNow: (): Promise<UpdateStatus> => ipcRenderer.invoke('updates:checkNow'),
    installNow: (): Promise<UpdateStatus> => ipcRenderer.invoke('updates:installNow'),
    onStatusChange: (cb: (s: UpdateStatus) => void): (() => void) => {
      const sub = (_e: unknown, s: UpdateStatus) => cb(s);
      ipcRenderer.on('updates:status:push', sub);
      return () => {
        ipcRenderer.off('updates:status:push', sub);
      };
    },
    onOpenSettings: (cb: () => void): (() => void) => {
      const sub = () => cb();
      ipcRenderer.on('updates:open-settings', sub);
      return () => {
        ipcRenderer.off('updates:open-settings', sub);
      };
    },
  },
  insights: {
    today: (): Promise<{
      day: string;
      score: { score: number; trackedMinutes: number; engagedMinutes: number; protectedMinutes: number; idleMinutes: number };
      totals: { keystrokes: number; clicks: number; mouseDistancePx: number; scrollEvents: number };
      byHour: number[];
    }> => ipcRenderer.invoke('insights:today'),
  },
  lark: {
    status: (): Promise<{ configured: boolean; connected: boolean; reauthRequired: boolean; scopes: string[] }> =>
      ipcRenderer.invoke('lark:status'),
    connect: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('lark:connect'),
    disconnect: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('lark:disconnect'),
    tasks: (): Promise<{ tasks: { guid: string; summary: string; completed: boolean; url?: string; due: number | null; createdAt: number | null; creatorId: string | null; creatorName: string | null; loggedMs: number }[]; reauthRequired: boolean }> =>
      ipcRenderer.invoke('lark:tasks'),
    sync: (): Promise<{ ok: boolean; connected: boolean; reauthRequired: boolean; tasks: { guid: string; summary: string; completed: boolean; url?: string; due: number | null; createdAt: number | null; creatorId: string | null; creatorName: string | null; loggedMs: number }[]; syncedAt: number | null; error?: string }> =>
      ipcRenderer.invoke('lark:sync'),
    createTask: (input: { summary: string; due?: number | null; description?: string | null }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('lark:createTask', input),
  },
};

contextBridge.exposeInMainWorld('agent', api);

export type AgentBridge = typeof api;
