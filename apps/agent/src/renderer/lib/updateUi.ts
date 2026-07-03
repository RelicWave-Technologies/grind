import type { UpdateStatus } from './agent.d';

export type UpdateAction = 'check' | 'restart' | 'none';

export function updatePercent(status?: UpdateStatus): number {
  return Math.round(status?.percent ?? 0);
}

export function settingsUpdateSubtitle(status?: UpdateStatus): string {
  const percent = updatePercent(status);
  if (!status) return 'Checking update status…';
  if (!status.enabled) return 'Release updates are off in this build';
  if (status.phase === 'checking') return 'Checking for updates…';
  if (status.phase === 'available') return `Downloading ${status.availableVersion ?? 'update'}…`;
  if (status.phase === 'downloading') return `Downloading ${percent}%`;
  if (status.phase === 'ready') {
    return status.canInstallNow
      ? `Version ${status.availableVersion ?? 'new'} is ready`
      : 'Update ready — restart after you stop tracking.';
  }
  if (status.phase === 'installing') return 'Restarting Timo…';
  if (status.phase === 'not-available' && status.manual) return 'You’re up to date';
  if (status.phase === 'error' && status.manual) return 'Couldn’t check for updates';
  return `Channel: ${status.channel === 'beta' ? 'Beta' : 'Stable'}`;
}

export function updateAction(status?: UpdateStatus, busy = false): { kind: UpdateAction; label: string; disabled: boolean } {
  if (status?.phase === 'ready' && status.canInstallNow) {
    return { kind: 'restart', label: 'Restart to update', disabled: busy };
  }
  if (status?.phase === 'installing') {
    return { kind: 'restart', label: 'Restarting…', disabled: true };
  }
  if (status?.phase === 'ready') {
    return { kind: 'none', label: '', disabled: true };
  }
  if (!status?.enabled || busy || status?.phase === 'checking' || status?.phase === 'downloading') {
    return { kind: 'check', label: status?.phase === 'checking' ? 'Checking…' : 'Check for updates', disabled: true };
  }
  return { kind: 'check', label: 'Check for updates', disabled: false };
}

export function updateReadyBannerText(status?: UpdateStatus): string | null {
  if (status?.phase === 'installing') return 'Restarting Timo…';
  if (status?.phase !== 'ready') return null;
  if (!status.canInstallNow) return 'Update ready — restart after you stop tracking.';
  return `Timo ${status.availableVersion ?? ''} is ready.`;
}
