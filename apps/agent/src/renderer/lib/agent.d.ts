import type { UserDto } from '@grind/types';
import type {
  TimerStatus,
  TrackingCommandResult,
  TrackingReadiness,
} from '../../shared/tracking';
import type { LaunchAtLoginHealth, MoveToApplicationsResult } from '../../shared/launchAtLogin';

type AuthStatus = 'loggedIn' | 'loggedOut';
type LarkOutcome = { kind: 'pending' } | { kind: 'error'; reason: string };
type AgentStatus = { state: 'IDLE' | 'OFFLINE'; lastHeartbeatAt: string | null };
export type TimerRecoveryNotice = { entryId: string; recoveredAt: number; reason: 'unexpected_shutdown' | 'sleep_stop' | 'lock_stop' | 'server_finalized'; observedAt: number };
export type TodaySegment = { kind: 'WORK' | 'MEETING' | 'IDLE_TRIMMED'; startedAt: number; endedAt: number | null };
export type TodayEntry = { id: string; larkTaskGuid: string | null; segments: TodaySegment[] };
export type AwayInfo = { larkTaskGuid: string | null; stoppedAt: number; reason: 'suspend' | 'lock' };
export type ScreenshotItem = {
  id: string;
  capturedAt: number;
  thumb: string | null;
  uploadState: string;
  keyboardPct: number;
  mousePct: number;
  attempts: number;
  lastError: string | null;
};
export type ScreenshotUploadSummary = { pending: number; uploading: number; failed: number };
export type AccessibilityStatus = {
  trusted: boolean;
  capturing: boolean;
  ready: boolean;
  recording: boolean;
  hookRunning: boolean;
  lastHookError: string | null;
};
export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'not-available' | 'error';
export type UpdateStatus = {
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

declare global {
  interface Window {
    agent: {
      auth: {
        login: (email: string, password: string) => Promise<UserDto>;
        loginWithLark: () => Promise<{ ok: true }>;
        logout: () => Promise<{ ok: true }>;
        status: () => Promise<AuthStatus>;
        me: () => Promise<{ name: string; avatarUrl: string | null } | null>;
        onStatusChange: (cb: (s: AuthStatus) => void) => () => void;
        onLarkOutcome: (cb: (o: LarkOutcome) => void) => () => void;
      };
      agent: {
        status: () => Promise<AgentStatus>;
      };
      timer: {
        start: (larkTaskGuid?: string | null) => Promise<TrackingCommandResult>;
        stop: () => Promise<TimerStatus>;
        resume: () => Promise<TrackingCommandResult>;
        status: () => Promise<TimerStatus>;
        recoveryNotice: () => Promise<TimerRecoveryNotice | null>;
        dismissRecoveryNotice: () => Promise<{ ok: true }>;
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
      away: {
        get: () => Promise<AwayInfo | null>;
        resume: () => Promise<TrackingCommandResult>;
        dismiss: () => Promise<{ ok: true }>;
      };
      shift: {
        decide: (decision: 'yes' | 'not_yet') => Promise<void>;
        refresh: () => Promise<void>;
      };
      screenshots: {
        recent: (limit?: number) => Promise<ScreenshotItem[]>;
        countToday: () => Promise<number>;
        captureOnce: () => Promise<number>;
        full: (id: string) => Promise<string | null>;
        uploadSummary: () => Promise<ScreenshotUploadSummary>;
        retryFailedUploads: () => Promise<{ reset: number }>;
      };
      permissions: {
        readiness: () => Promise<TrackingReadiness>;
        requestScreen: () => Promise<TrackingReadiness>;
        promptContext: () => Promise<{ action: 'START' | 'RESUME' } | null>;
        retryPending: () => Promise<TrackingCommandResult | null>;
        closePrompt: () => Promise<{ ok: true }>;
        screen: () => Promise<{ status: string; health: string; state: 'ok' | 'needs-grant' | 'needs-settings' | 'needs-restart' }>;
        accessibility: () => Promise<AccessibilityStatus>;
        requestAccessibility: () => Promise<void>;
      };
      settings: {
        get: () => Promise<{ version: string; platform: string; launchAtLogin: LaunchAtLoginHealth; screenStatus: string; floatingBarVisible: boolean }>;
        repairLaunchAtLogin: () => Promise<LaunchAtLoginHealth>;
        moveToApplications: () => Promise<MoveToApplicationsResult>;
        setFloatingBarVisible: (enabled: boolean) => Promise<boolean>;
        resetFloatingBarPosition: () => Promise<void>;
        openScreenPrefs: () => Promise<void>;
        openStartupPrefs: () => Promise<void>;
        onOpen: (cb: () => void) => () => void;
        openDataFolder: () => Promise<void>;
      };
      app: {
        relaunch: () => Promise<void>;
        openDashboard: () => Promise<{ ok: boolean; error?: string }>;
      };
      updates: {
        status: () => Promise<UpdateStatus>;
        checkNow: () => Promise<UpdateStatus>;
        checkQuietly: () => Promise<UpdateStatus>;
        installNow: () => Promise<UpdateStatus>;
        onStatusChange: (cb: (s: UpdateStatus) => void) => () => void;
        onOpenSettings: (cb: () => void) => () => void;
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
        status: () => Promise<{ configured: boolean; connected: boolean; reauthRequired: boolean; scopes: string[]; missingScopes?: string[] }>;
        connect: () => Promise<{ ok: boolean; error?: string }>;
        disconnect: () => Promise<{ ok: boolean }>;
        tasks: () => Promise<{ tasks: { guid: string; summary: string; completed: boolean; url?: string; due: number | null; createdAt: number | null; creatorId: string | null; creatorName: string | null; loggedMs: number; loggedTodayMs: number; loggedTotalMs: number }[]; reauthRequired: boolean }>;
        sync: () => Promise<{ ok: boolean; connected: boolean; reauthRequired: boolean; tasks: { guid: string; summary: string; completed: boolean; url?: string; due: number | null; createdAt: number | null; creatorId: string | null; creatorName: string | null; loggedMs: number; loggedTodayMs: number; loggedTotalMs: number }[]; syncedAt: number | null; error?: string }>;
        createTask: (input: { summary: string; due?: number | null; description?: string | null }) => Promise<{ ok: boolean; error?: string }>;
      };
    };
  }
}

export type { TimerStatus, TrackingCommandResult, TrackingReadiness };
