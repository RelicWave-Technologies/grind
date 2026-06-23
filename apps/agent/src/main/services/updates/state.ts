import type { UpdateChannel } from '../../env';

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'not-available'
  | 'error';

export interface UpdateStatus {
  phase: UpdatePhase;
  enabled: boolean;
  currentVersion: string;
  channel: UpdateChannel;
  availableVersion: string | null;
  percent: number | null;
  error: string | null;
  checkedAt: number | null;
  readyAt: number | null;
  manual: boolean;
  canInstallNow: boolean;
}

export type TimerInstallState =
  | { state: 'IDLE' }
  | { state: 'RUNNING'; paused: boolean };

export type UpdateEvent =
  | { type: 'checking'; manual: boolean; at: number }
  | { type: 'available'; version: string | null }
  | { type: 'download-progress'; percent: number }
  | { type: 'downloaded'; version: string | null; canInstallNow: boolean; at: number }
  | { type: 'not-available'; manual: boolean; at: number }
  | { type: 'error'; message: string; manual: boolean; at: number }
  | { type: 'timer-changed'; canInstallNow: boolean };

export function initialUpdateStatus(args: {
  enabled: boolean;
  currentVersion: string;
  channel: UpdateChannel;
  canInstallNow?: boolean;
}): UpdateStatus {
  return {
    phase: 'idle',
    enabled: args.enabled,
    currentVersion: args.currentVersion,
    channel: args.channel,
    availableVersion: null,
    percent: null,
    error: null,
    checkedAt: null,
    readyAt: null,
    manual: false,
    canInstallNow: args.canInstallNow ?? true,
  };
}

export function canInstallUpdate(timer: TimerInstallState): boolean {
  return timer.state === 'IDLE';
}

export function nextRetryDelayMs(automaticErrorCount: number): number | null {
  if (automaticErrorCount <= 1) return 15 * 60_000;
  if (automaticErrorCount === 2) return 60 * 60_000;
  return null;
}

export function applyUpdateEvent(status: UpdateStatus, event: UpdateEvent): UpdateStatus {
  switch (event.type) {
    case 'checking':
      return {
        ...status,
        phase: 'checking',
        percent: null,
        error: null,
        manual: event.manual,
      };
    case 'available':
      return {
        ...status,
        phase: 'available',
        availableVersion: event.version ?? status.availableVersion,
        percent: 0,
        error: null,
      };
    case 'download-progress':
      return {
        ...status,
        phase: 'downloading',
        percent: Math.max(0, Math.min(100, event.percent)),
        error: null,
      };
    case 'downloaded':
      return {
        ...status,
        phase: 'ready',
        availableVersion: event.version ?? status.availableVersion,
        percent: 100,
        error: null,
        checkedAt: event.at,
        readyAt: event.at,
        canInstallNow: event.canInstallNow,
      };
    case 'not-available':
      return {
        ...status,
        phase: 'not-available',
        availableVersion: null,
        percent: null,
        error: null,
        checkedAt: event.at,
        manual: event.manual,
      };
    case 'error':
      return {
        ...status,
        phase: 'error',
        error: event.message,
        checkedAt: event.at,
        manual: event.manual,
      };
    case 'timer-changed':
      return {
        ...status,
        canInstallNow: event.canInstallNow,
      };
  }
}
