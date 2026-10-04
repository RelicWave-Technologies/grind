import type { UpdateChannel } from '../../env';

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
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
  | { type: 'installing'; at: number }
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

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

function parseVersion(version: string | null | undefined): ParsedVersion | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/u.exec(version ?? '');
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split('.') ?? [],
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i += 1) {
    const ai = a[i];
    const bi = b[i];
    if (ai == null) return -1;
    if (bi == null) return 1;
    const an = /^\d+$/u.test(ai) ? Number(ai) : null;
    const bn = /^\d+$/u.test(bi) ? Number(bi) : null;
    if (an != null && bn != null && an !== bn) return an > bn ? 1 : -1;
    if (an != null && bn == null) return -1;
    if (an == null && bn != null) return 1;
    if (an == null && bn == null && ai !== bi) return ai > bi ? 1 : -1;
  }
  return 0;
}

export function compareVersions(a: string, b: string): number | null {
  const av = parseVersion(a);
  const bv = parseVersion(b);
  if (!av || !bv) return null;
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (av[key] !== bv[key]) return av[key] > bv[key] ? 1 : -1;
  }
  return comparePrerelease(av.prerelease, bv.prerelease);
}

export function isVersionNewer(currentVersion: string, candidateVersion: string | null | undefined): boolean {
  if (!candidateVersion) return false;
  const compared = compareVersions(candidateVersion, currentVersion);
  return compared == null ? candidateVersion !== currentVersion : compared > 0;
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
      if (!isVersionNewer(status.currentVersion, event.version)) {
        return {
          ...status,
          phase: 'not-available',
          availableVersion: null,
          percent: null,
          error: null,
        };
      }
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
      if (!isVersionNewer(status.currentVersion, event.version)) {
        return {
          ...status,
          phase: 'not-available',
          availableVersion: null,
          percent: null,
          error: null,
          checkedAt: event.at,
          readyAt: null,
        };
      }
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
    case 'installing':
      return {
        ...status,
        phase: 'installing',
        percent: 100,
        error: null,
        checkedAt: event.at,
        manual: true,
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
