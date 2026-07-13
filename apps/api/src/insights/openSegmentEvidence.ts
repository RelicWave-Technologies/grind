const MIN = 60 * 1000;

/**
 * Open segments are allowed to read as live only while there is fresh evidence
 * that the agent is still alive. Old builds can leave endedAt=null forever; if
 * we blindly extend those to "now", reports turn an abandoned timer into a full
 * green day.
 */
export const OPEN_SEGMENT_FRESH_MS = 10 * MIN;
export const ACTIVITY_SAMPLE_SPAN_MS = MIN;

export interface ActivitySampleEvidence {
  timeEntryId: string | null;
  bucketStart: Date;
}

export interface TimerLifecycleEvidence {
  trackingProtocolVersion?: number | null;
  lastProvenAt?: Date | null;
  leaseExpiresAt?: Date | null;
}

export function latestSampleByEntry(samples: ActivitySampleEvidence[]): Map<string, Date> {
  const latest = new Map<string, Date>();
  for (const sample of samples) {
    if (!sample.timeEntryId) continue;
    const prev = latest.get(sample.timeEntryId);
    if (!prev || sample.bucketStart > prev) latest.set(sample.timeEntryId, sample.bucketStart);
  }
  return latest;
}

export function resolveEffectiveSegmentEnd(input: {
  startedAt: Date;
  endedAt: Date | null;
  now: Date;
  latestSampleAt?: Date | null;
  lifecycle?: TimerLifecycleEvidence | null;
}): Date | null {
  if (input.endedAt) return input.endedAt;

  const startMs = input.startedAt.getTime();
  const nowMs = input.now.getTime();
  if (input.lifecycle?.trackingProtocolVersion === 2) {
    const leaseExpiresMs = input.lifecycle.leaseExpiresAt?.getTime() ?? null;
    if (leaseExpiresMs !== null && leaseExpiresMs > nowMs) return null;

    const provenMs = input.lifecycle.lastProvenAt?.getTime() ?? startMs;
    return new Date(Math.min(nowMs, Math.max(startMs, provenMs)));
  }

  const latestSampleEndMs = input.latestSampleAt
    ? input.latestSampleAt.getTime() + ACTIVITY_SAMPLE_SPAN_MS
    : null;

  if (latestSampleEndMs !== null && latestSampleEndMs >= startMs) {
    if (latestSampleEndMs >= nowMs - OPEN_SEGMENT_FRESH_MS) return null;
    return new Date(Math.min(latestSampleEndMs, nowMs));
  }

  if (nowMs - startMs <= OPEN_SEGMENT_FRESH_MS) return null;
  return input.startedAt;
}

/** Backward-compatible name while callers converge on the shared resolver. */
export const cappedOpenEndedAt = resolveEffectiveSegmentEnd;

export function openSegmentIsFresh(input: {
  startedAt: Date;
  endedAt: Date | null;
  now: Date;
  latestSampleAt?: Date | null;
  lifecycle?: TimerLifecycleEvidence | null;
}): boolean {
  return input.endedAt === null && resolveEffectiveSegmentEnd(input) === null;
}
