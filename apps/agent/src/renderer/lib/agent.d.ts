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
        get: () => Promise<{ version: string; platform: string; launchAtLogin: boolean; screenStatus: string }>;
        setLaunchAtLogin: (enabled: boolean) => Promise<boolean>;
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
        day: (args: { date: string; tz: string }) => Promise<DayInsight>;
      };
      lark: {
        status: () => Promise<{ configured: boolean; connected: boolean; reauthRequired: boolean; scopes: string[] }>;
        connect: () => Promise<{ ok: boolean; error?: string }>;
        disconnect: () => Promise<{ ok: boolean }>;
        tasks: () => Promise<{ tasks: { guid: string; summary: string; completed: boolean; url?: string; due: number | null; createdAt: number | null; creatorId: string | null; creatorName: string | null; loggedMs: number }[]; reauthRequired: boolean }>;
        createTask: (input: { summary: string; due?: number | null; description?: string | null }) => Promise<{ ok: boolean; error?: string }>;
      };
      timeRequests: {
        create: (input: {
          requestedStart: number;
          requestedEnd: number;
          reason: string;
          larkTaskGuid?: string | null;
          taskSummary?: string | null;
        }) => Promise<{ ok: boolean; request?: ManualTimeRequestDto; error?: string }>;
        listMine: (status?: 'PENDING' | 'APPROVED' | 'REJECTED') => Promise<{ requests: ManualTimeRequestDto[] }>;
      };
    };
  }
}

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
  blocks: Array<{
    kind: 'WORK' | 'MEETING' | 'IDLE_TRIMMED' | 'MANUAL' | 'GAP';
    startedAt: number;
    endedAt: number;
    durationMs: number;
    timeEntryId?: string;
    larkTaskGuid?: string | null;
    isOpen?: boolean;
  }>;
  pendingOverlay: Array<{ id: string; startedAt: number; endedAt: number; reason: string; larkTaskGuid: string | null }>;
};

export type ManualTimeRequestDto = {
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

export { TimerStatus };
