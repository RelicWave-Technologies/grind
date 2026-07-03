export type MonitoringSettingsRiskLevel = 'NORMAL' | 'CAUTION' | 'HIGH';

export type MonitoringTiming = {
  screenshotIntervalMin: number;
  idleThresholdMin: number;
};

export function monitoringRiskLevel(timing: MonitoringTiming): MonitoringSettingsRiskLevel {
  if (timing.screenshotIntervalMin === 1 || timing.idleThresholdMin === 1) return 'HIGH';
  if (timing.screenshotIntervalMin <= 5 || timing.idleThresholdMin <= 3) return 'CAUTION';
  return 'NORMAL';
}

export function monitoringTimingChanged(previous: MonitoringTiming, next: MonitoringTiming): boolean {
  return previous.screenshotIntervalMin !== next.screenshotIntervalMin ||
    previous.idleThresholdMin !== next.idleThresholdMin;
}

export function normalizeAuditReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 500) : null;
}
