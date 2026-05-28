import { contextBridge, ipcRenderer } from 'electron';
import type { UserDto, ProjectDto } from '@grind/types';

type AuthStatus = 'loggedIn' | 'loggedOut';
type AgentStatus = { state: 'IDLE' | 'OFFLINE'; lastHeartbeatAt: string | null };
type TimerStatus =
  | { state: 'IDLE' }
  | { state: 'RUNNING'; entryId: string; projectId: string; taskId: string | null; startedAt: number; workedMs: number; paused: boolean };
type TodaySegment = { kind: 'WORK' | 'MEETING' | 'IDLE_TRIMMED'; startedAt: number; endedAt: number | null };
type TodayEntry = { id: string; projectId: string; segments: TodaySegment[] };

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
  projects: {
    list: (): Promise<ProjectDto[]> => ipcRenderer.invoke('projects:list'),
  },
  agent: {
    status: (): Promise<AgentStatus> => ipcRenderer.invoke('agent:status'),
  },
  timer: {
    start: (projectId: string, taskId?: string | null): Promise<TimerStatus> =>
      ipcRenderer.invoke('timer:start', { projectId, taskId }),
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
  screenshots: {
    recent: (limit?: number): Promise<{ id: string; capturedAt: number; thumb: string | null; uploadState: string }[]> =>
      ipcRenderer.invoke('screenshots:recent', limit),
    countToday: (): Promise<number> => ipcRenderer.invoke('screenshots:countToday'),
    captureOnce: (): Promise<number> => ipcRenderer.invoke('screenshots:captureOnce'),
  },
  permissions: {
    screenStatus: (): Promise<string> => ipcRenderer.invoke('permissions:screenStatus'),
  },
  settings: {
    get: (): Promise<{ version: string; platform: string; launchAtLogin: boolean; screenStatus: string }> =>
      ipcRenderer.invoke('settings:get'),
    setLaunchAtLogin: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('settings:setLaunchAtLogin', enabled),
    openScreenPrefs: (): Promise<void> => ipcRenderer.invoke('settings:openScreenPrefs'),
    openDataFolder: (): Promise<void> => ipcRenderer.invoke('settings:openDataFolder'),
  },
};

contextBridge.exposeInMainWorld('agent', api);

export type AgentBridge = typeof api;
