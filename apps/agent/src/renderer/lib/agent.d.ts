import type { UserDto } from '@grind/types';

type AuthStatus = 'loggedIn' | 'loggedOut';
type AgentStatus = { state: 'IDLE' | 'OFFLINE'; lastHeartbeatAt: string | null };
type TimerStatus =
  | { state: 'IDLE' }
  | { state: 'RUNNING'; entryId: string; larkTaskGuid: string | null; startedAt: number; workedMs: number; paused: boolean };
export type TodaySegment = { kind: 'WORK' | 'MEETING' | 'IDLE_TRIMMED'; startedAt: number; endedAt: number | null };
export type TodayEntry = { id: string; larkTaskGuid: string | null; segments: TodaySegment[] };

declare global {
  interface Window {
    agent: {
      auth: {
        login: (email: string, password: string) => Promise<UserDto>;
        logout: () => Promise<{ ok: true }>;
        status: () => Promise<AuthStatus>;
        onStatusChange: (cb: (s: AuthStatus) => void) => () => void;
      };
      agent: {
        status: () => Promise<AgentStatus>;
      };
      timer: {
        start: (larkTaskGuid?: string | null) => Promise<TimerStatus>;
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
      shift: {
        decide: (decision: 'yes' | 'not_yet') => Promise<void>;
        refresh: () => Promise<void>;
      };
      screenshots: {
        recent: (limit?: number) => Promise<{ id: string; capturedAt: number; thumb: string | null; uploadState: string; keyboardPct: number; mousePct: number }[]>;
        countToday: () => Promise<number>;
        captureOnce: () => Promise<number>;
        full: (id: string) => Promise<string | null>;
      };
      permissions: {
        screen: () => Promise<{ status: string; health: string; state: 'ok' | 'needs-grant' | 'needs-settings' | 'needs-restart' }>;
        accessibility: () => Promise<{ trusted: boolean; capturing: boolean }>;
        requestAccessibility: () => Promise<void>;
      };
      settings: {
        get: () => Promise<{ version: string; platform: string; launchAtLogin: boolean; screenStatus: string; floatingBarVisible: boolean }>;
        setLaunchAtLogin: (enabled: boolean) => Promise<boolean>;
        setFloatingBarVisible: (enabled: boolean) => Promise<boolean>;
        resetFloatingBarPosition: () => Promise<void>;
        openScreenPrefs: () => Promise<void>;
        openDataFolder: () => Promise<void>;
      };
      app: {
        relaunch: () => Promise<void>;
      };
      insights: {
        today: () => Promise<{
          day: string;
          score: { score: number; trackedMinutes: number; engagedMinutes: number; protectedMinutes: number; idleMinutes: number };
          totals: { keystrokes: number; clicks: number; mouseDistancePx: number; scrollEvents: number };
          byHour: number[];
        }>;
      };
      lark: {
        status: () => Promise<{ configured: boolean; connected: boolean; reauthRequired: boolean; scopes: string[] }>;
        connect: () => Promise<{ ok: boolean; error?: string }>;
        disconnect: () => Promise<{ ok: boolean }>;
        tasks: () => Promise<{ tasks: { guid: string; summary: string; completed: boolean; url?: string; due: number | null; createdAt: number | null; creatorId: string | null; creatorName: string | null; loggedMs: number }[]; reauthRequired: boolean }>;
        createTask: (input: { summary: string; due?: number | null; description?: string | null }) => Promise<{ ok: boolean; error?: string }>;
      };
    };
  }
}

export { TimerStatus };
