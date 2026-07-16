import { contextBridge, ipcRenderer } from 'electron';
import type { UserDto } from '@grind/types';
import type {
  TimerStatus,
  TrackingCommandResult,
  TrackingReadiness,
} from '../shared/tracking';
import type { LaunchAtLoginHealth, MoveToApplicationsResult } from '../shared/launchAtLogin';
import type { AttentionAction, AttentionActionResult, AttentionPrompt } from '../shared/attention';
import type { WorkspaceTimeContext } from '../shared/workspaceTime';

type AuthStatus = 'loggedIn' | 'loggedOut';
type LarkOutcome = { kind: 'pending' } | { kind: 'error'; reason: string };
type AgentStatus = { state: 'IDLE' | 'OFFLINE'; lastHeartbeatAt: string | null };
type TimerRecoveryNotice = { entryId: string; recoveredAt: number; reason: 'unexpected_shutdown' | 'sleep_stop' | 'lock_stop' | 'server_finalized'; observedAt: number };
type TodaySegment = { kind: 'WORK' | 'MEETING' | 'IDLE_TRIMMED'; startedAt: number; endedAt: number | null };
type TodayEntry = { id: string; larkTaskGuid: string | null; segments: TodaySegment[] };
type ScreenshotItem = {
  id: string;
  capturedAt: number;
  uploadState: string;
  keyboardPct: number;
  mousePct: number;
  attempts: number;
  lastError: string | null;
};
type ScreenshotUploadSummary = { pending: number; uploading: number; failed: number };
type AccessibilityStatus = {
  trusted: boolean;
  capturing: boolean;
  ready: boolean;
  recording: boolean;
  hookRunning: boolean;
  lastHookError: string | null;
};
type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing' | 'not-available' | 'error';
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
  workspaceTime: {
    get: (): Promise<WorkspaceTimeContext> => ipcRenderer.invoke('workspaceTime:get'),
    onChange: (cb: (context: WorkspaceTimeContext) => void): (() => void) => {
      const sub = (_event: unknown, context: WorkspaceTimeContext) => cb(context);
      ipcRenderer.on('workspaceTime:push', sub);
      return () => ipcRenderer.off('workspaceTime:push', sub);
    },
  },
  timer: {
    start: (larkTaskGuid?: string | null): Promise<TrackingCommandResult> =>
      ipcRenderer.invoke('timer:start', { larkTaskGuid }),
    pause: (): Promise<TimerStatus> => ipcRenderer.invoke('timer:pause'),
    stop: (): Promise<TimerStatus> => ipcRenderer.invoke('timer:stop'),
    resume: (): Promise<TrackingCommandResult> => ipcRenderer.invoke('timer:resume'),
    status: (): Promise<TimerStatus> => ipcRenderer.invoke('timer:status'),
    recoveryNotice: (): Promise<TimerRecoveryNotice | null> => ipcRenderer.invoke('timer:recoveryNotice'),
    dismissRecoveryNotice: (): Promise<{ ok: true }> => ipcRenderer.invoke('timer:dismissRecoveryNotice'),
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
    dismissFloatingBar: (): Promise<void> => ipcRenderer.invoke('window:dismissFloatingBar'),
  },
  attention: {
    get: (): Promise<AttentionPrompt> => ipcRenderer.invoke('attention:get'),
    resolve: (promptId: string, action: AttentionAction): Promise<AttentionActionResult> =>
      ipcRenderer.invoke('attention:resolve', { promptId, action }),
    yieldToSystemSettings: (promptId: string): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('attention:yieldToSystemSettings', promptId),
    onChange: (cb: (prompt: AttentionPrompt) => void): (() => void) => {
      const sub = (_event: unknown, prompt: AttentionPrompt) => cb(prompt);
      ipcRenderer.on('attention:state:push', sub);
      return () => ipcRenderer.off('attention:state:push', sub);
    },
  },
  shift: {
    decide: (decision: 'yes' | 'not_yet'): Promise<void> => ipcRenderer.invoke('shift:decide', decision),
    refresh: (): Promise<void> => ipcRenderer.invoke('shift:refresh'),
  },
  screenshots: {
    recent: (limit?: number): Promise<ScreenshotItem[]> => ipcRenderer.invoke('screenshots:recent', limit),
    countToday: (): Promise<number> => ipcRenderer.invoke('screenshots:countToday'),
    captureOnce: (): Promise<number> => ipcRenderer.invoke('screenshots:captureOnce'),
    thumbnail: (id: string): Promise<string | null> => ipcRenderer.invoke('screenshots:thumbnail', id),
    full: (id: string): Promise<string | null> => ipcRenderer.invoke('screenshots:full', id),
    uploadSummary: (): Promise<ScreenshotUploadSummary> => ipcRenderer.invoke('screenshots:uploadSummary'),
    retryFailedUploads: (): Promise<{ reset: number }> => ipcRenderer.invoke('screenshots:retryFailedUploads'),
    onChange: (cb: () => void): (() => void) => {
      const sub = () => cb();
      ipcRenderer.on('screenshots:changed', sub);
      return () => ipcRenderer.off('screenshots:changed', sub);
    },
  },
  permissions: {
    readiness: (): Promise<TrackingReadiness> => ipcRenderer.invoke('permissions:readiness'),
    requestScreen: (): Promise<TrackingReadiness> => ipcRenderer.invoke('permissions:requestScreen'),
    screen: (): Promise<{ status: string; health: string; state: 'ok' | 'needs-grant' | 'needs-settings' | 'needs-restart' }> =>
      ipcRenderer.invoke('permissions:screen'),
    accessibility: (): Promise<AccessibilityStatus> => ipcRenderer.invoke('permissions:accessibility'),
    requestAccessibility: (): Promise<void> => ipcRenderer.invoke('permissions:requestAccessibility'),
  },
  settings: {
    get: (): Promise<{ version: string; platform: string; launchAtLogin: LaunchAtLoginHealth; screenStatus: string; floatingBarVisible: boolean }> =>
      ipcRenderer.invoke('settings:get'),
    repairLaunchAtLogin: (): Promise<LaunchAtLoginHealth> => ipcRenderer.invoke('settings:repairLaunchAtLogin'),
    moveToApplications: (): Promise<MoveToApplicationsResult> => ipcRenderer.invoke('settings:moveToApplications'),
    setFloatingBarVisible: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('settings:setFloatingBarVisible', enabled),
    resetFloatingBarPosition: (): Promise<void> => ipcRenderer.invoke('settings:resetFloatingBarPosition'),
    openScreenPrefs: (): Promise<void> => ipcRenderer.invoke('settings:openScreenPrefs'),
    openStartupPrefs: (): Promise<void> => ipcRenderer.invoke('settings:openStartupPrefs'),
    onOpen: (cb: () => void): (() => void) => {
      const sub = () => cb();
      ipcRenderer.on('settings:open:push', sub);
      return () => ipcRenderer.off('settings:open:push', sub);
    },
    openDataFolder: (): Promise<void> => ipcRenderer.invoke('settings:openDataFolder'),
  },
  app: {
    relaunch: (): Promise<void> => ipcRenderer.invoke('app:relaunch'),
    openDashboard: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('app:openDashboard'),
  },
  updates: {
    status: (): Promise<UpdateStatus> => ipcRenderer.invoke('updates:status'),
    checkNow: (): Promise<UpdateStatus> => ipcRenderer.invoke('updates:checkNow'),
    checkQuietly: (): Promise<UpdateStatus> => ipcRenderer.invoke('updates:checkQuietly'),
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
    status: (): Promise<{ configured: boolean; connected: boolean; reauthRequired: boolean; scopes: string[]; offline?: boolean }> =>
      ipcRenderer.invoke('lark:status'),
    connect: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('lark:connect'),
    disconnect: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('lark:disconnect'),
    tasks: (): Promise<{ tasks: { guid: string; summary: string; completed: boolean; url?: string; due: number | null; createdAt: number | null; creatorId: string | null; creatorName: string | null; loggedMs: number; loggedTodayMs: number; loggedTotalMs: number }[]; reauthRequired: boolean; offline?: boolean }> =>
      ipcRenderer.invoke('lark:tasks'),
    sync: (): Promise<{ ok: boolean; connected: boolean; reauthRequired: boolean; tasks: { guid: string; summary: string; completed: boolean; url?: string; due: number | null; createdAt: number | null; creatorId: string | null; creatorName: string | null; loggedMs: number; loggedTodayMs: number; loggedTotalMs: number }[]; syncedAt: number | null; error?: string }> =>
      ipcRenderer.invoke('lark:sync'),
    createTask: (input: { summary: string; due?: number | null; description?: string | null }): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke('lark:createTask', input),
    onConnectionChange: (cb: (outcome: 'connected' | 'cancelled' | 'failed') => void): (() => void) => {
      const sub = (_event: unknown, payload: { outcome: 'connected' | 'cancelled' | 'failed' }) => cb(payload.outcome);
      ipcRenderer.on('lark:connection:push', sub);
      return () => ipcRenderer.off('lark:connection:push', sub);
    },
  },
};

contextBridge.exposeInMainWorld('agent', api);

export type AgentBridge = typeof api;
