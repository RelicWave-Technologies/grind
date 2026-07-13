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

/**
 * Screenshots are durable proof that an AUTO entry was still collecting at a
 * particular instant. They deliberately carry no image data here: lifecycle
 * accounting needs only the capture timestamp.
 */
export interface ScreenshotEvidence {
  timeEntryId: string | null;
  capturedAt: Date;
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

export function latestScreenshotByEntry(screenshots: ScreenshotEvidence[]): Map<string, Date> {
  const latest = new Map<string, Date>();
  for (const screenshot of screenshots) {
    if (!screenshot.timeEntryId) continue;
    const prev = latest.get(screenshot.timeEntryId);
    if (!prev || screenshot.capturedAt > prev) latest.set(screenshot.timeEntryId, screenshot.capturedAt);
  }
  return latest;
}

export function resolveEffectiveSegmentEnd(input: {
  startedAt: Date;
  endedAt: Date | null;
  now: Date;
  latestSampleAt?: Date | null;
  latestScreenshotAt?: Date | null;
  /** A fresh heartbeat is valid only when the caller has matched it to this entry. */
  latestHeartbeatAt?: Date | null;
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
  const latestStoredProofMs = Math.max(
    latestSampleEndMs ?? Number.NEGATIVE_INFINITY,
    input.latestScreenshotAt?.getTime() ?? Number.NEGATIVE_INFINITY,
  );
  const latestHeartbeatMs = input.latestHeartbeatAt?.getTime() ?? Number.NEGATIVE_INFINITY;

  // A heartbeat is usable only when the caller has matched it to this exact
  // entry. It is the only legacy proof that permits a small live extension to
  // `now`; a screenshot/sample proves time only at its observed timestamp.
  if (latestHeartbeatMs >= startMs && latestHeartbeatMs >= nowMs - OPEN_SEGMENT_FRESH_MS) {
    return null;
  }

  if (latestStoredProofMs >= startMs) {
    return new Date(Math.min(latestStoredProofMs, nowMs));
  }

  if (latestHeartbeatMs >= startMs) {
    return new Date(Math.min(latestHeartbeatMs, nowMs));
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
  latestScreenshotAt?: Date | null;
  latestHeartbeatAt?: Date | null;
  lifecycle?: TimerLifecycleEvidence | null;
}): boolean {
  return input.endedAt === null && resolveEffectiveSegmentEnd(input) === null;
}
