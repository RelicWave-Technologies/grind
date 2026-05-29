import type { UserDto, ProjectDto } from '@grind/types';

type AuthStatus = 'loggedIn' | 'loggedOut';
type AgentStatus = { state: 'IDLE' | 'OFFLINE'; lastHeartbeatAt: string | null };
type TimerStatus =
  | { state: 'IDLE' }
  | { state: 'RUNNING'; entryId: string; projectId: string; taskId: string | null; larkTaskGuid: string | null; startedAt: number; workedMs: number; paused: boolean };
export type TodaySegment = { kind: 'WORK' | 'MEETING' | 'IDLE_TRIMMED'; startedAt: number; endedAt: number | null };
export type TodayEntry = { id: string; projectId: string; segments: TodaySegment[] };

declare global {
  interface Window {
    agent: {
      auth: {
        login: (email: string, password: string) => Promise<UserDto>;
        logout: () => Promise<{ ok: true }>;
        status: () => Promise<AuthStatus>;
        onStatusChange: (cb: (s: AuthStatus) => void) => () => void;
      };
      projects: {
        list: () => Promise<ProjectDto[]>;
      };
      agent: {
        status: () => Promise<AgentStatus>;
      };
      timer: {
        start: (projectId: string, taskId?: string | null, larkTaskGuid?: string | null) => Promise<TimerStatus>;
        stop: () => Promise<TimerStatus>;
        status: () => Promise<TimerStatus>;
        today: () => Promise<TodayEntry[]>;
        onStatusChange: (cb: (s: TimerStatus) => void) => () => void;
      };
      window: {
        openMain: () => Promise<void>;
      };
      idle: {
        get: () => Promise<{ idleStartedAt: number }>;
        resolve: (action: 'continue' | 'break') => Promise<void>;
      };
      screenshots: {
        recent: (limit?: number) => Promise<{ id: string; capturedAt: number; thumb: string | null; uploadState: string }[]>;
        countToday: () => Promise<number>;
        captureOnce: () => Promise<number>;
      };
      permissions: {
        screen: () => Promise<{ status: string; health: string; state: 'ok' | 'needs-grant' | 'needs-settings' | 'needs-restart' }>;
      };
      settings: {
        get: () => Promise<{ version: string; platform: string; launchAtLogin: boolean; screenStatus: string }>;
        setLaunchAtLogin: (enabled: boolean) => Promise<boolean>;
        openScreenPrefs: () => Promise<void>;
        openDataFolder: () => Promise<void>;
      };
      app: {
        relaunch: () => Promise<void>;
      };
      lark: {
        status: () => Promise<{ configured: boolean; connected: boolean; reauthRequired: boolean; scopes: string[] }>;
        connect: () => Promise<{ ok: boolean; error?: string }>;
        disconnect: () => Promise<{ ok: boolean }>;
        tasks: () => Promise<{ tasks: { guid: string; summary: string; completed: boolean; url?: string }[]; reauthRequired: boolean }>;
      };
    };
  }
}

export { TimerStatus };
