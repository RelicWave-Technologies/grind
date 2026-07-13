import {
  heartbeatIsFresh,
  LIVE_HEARTBEAT_FRESH_MS,
  type EntryLiveEvidence,
} from './liveEntryEvidence';

/**
 * Open segments are allowed to read as live only while there is fresh evidence
 * that the agent is still alive. Old builds can leave endedAt=null forever; if
 * we blindly extend those to "now", reports turn an abandoned timer into a full
 * green day.
 */
export const OPEN_SEGMENT_FRESH_MS = LIVE_HEARTBEAT_FRESH_MS;

export interface TimerLifecycleEvidence {
  trackingProtocolVersion?: number | null;
  lastProvenAt?: Date | null;
  leaseExpiresAt?: Date | null;
}

export function resolveEffectiveSegmentEnd(input: {
  startedAt: Date;
  endedAt: Date | null;
  now: Date;
  evidence?: EntryLiveEvidence | null;
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

  const latestStoredProofMs = input.evidence?.latestStoredProofAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const latestHeartbeatMs = input.evidence?.latestHeartbeatAt?.getTime() ?? Number.NEGATIVE_INFINITY;

  // A heartbeat is usable only when the caller has matched it to this exact
  // entry. It is the only legacy proof that permits a small live extension to
  // `now`; a screenshot/sample proves time only at its observed timestamp.
  if (heartbeatIsFresh(input.evidence, input.now, input.startedAt)) {
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

export function resolveEffectiveEntrySegmentEnds(input: {
  segments: ReadonlyArray<{ startedAt: Date; endedAt: Date | null }>;
  entryEndedAt?: Date | null;
  now: Date;
  evidence?: EntryLiveEvidence | null;
  lifecycle?: TimerLifecycleEvidence | null;
}): Array<Date | null> {
  const resolved: Array<Date | null> = Array.from({ length: input.segments.length }, () => null);
  const ordered = input.segments
    .map((segment, index) => ({ segment, index }))
    .sort((a, b) => a.segment.startedAt.getTime() - b.segment.startedAt.getTime());

  for (let position = 0; position < ordered.length; position += 1) {
    const { segment, index } = ordered[position]!;
    if (segment.endedAt) {
      resolved[index] = segment.endedAt;
      continue;
    }

    const nextStartedAt = ordered[position + 1]?.segment.startedAt ?? null;
    const structuralEnd = [nextStartedAt, input.entryEndedAt]
      .filter((value): value is Date => value !== null && value !== undefined)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    if (structuralEnd) {
      resolved[index] = new Date(Math.max(segment.startedAt.getTime(), structuralEnd.getTime()));
      continue;
    }

    resolved[index] = resolveEffectiveSegmentEnd({
      startedAt: segment.startedAt,
      endedAt: null,
      now: input.now,
      evidence: input.evidence,
      lifecycle: input.lifecycle,
    });
  }

  return resolved;
}

/** Backward-compatible name while callers converge on the shared resolver. */
export const cappedOpenEndedAt = resolveEffectiveSegmentEnd;

export function openSegmentIsFresh(input: {
  startedAt: Date;
  endedAt: Date | null;
  now: Date;
  evidence?: EntryLiveEvidence | null;
  lifecycle?: TimerLifecycleEvidence | null;
}): boolean {
  return input.endedAt === null && resolveEffectiveSegmentEnd(input) === null;
}
