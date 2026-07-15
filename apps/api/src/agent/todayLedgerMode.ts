import type { TodayLedgerMode } from '@grind/types';

export function resolveTodayLedgerMode(
  configuredMode: TodayLedgerMode,
  canaryUserIds: string | undefined,
  userId: string,
): TodayLedgerMode {
  if (configuredMode === 'OFF') return 'OFF';
  const canaries = new Set(
    (canaryUserIds ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  return canaries.size === 0 || canaries.has(userId) ? configuredMode : 'OFF';
}
