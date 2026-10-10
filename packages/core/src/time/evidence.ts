/**
 * How far an open segment is allowed to count.
 *
 * An open segment (`endedAt === null`) reads as live only while there is fresh
 * evidence the agent is still alive. Old builds can leave a segment open
 * forever; extending those to "now" turns an abandoned timer into a full green
 * day. Every surface — Edit Time, reports, Lark, the agent's ledger, the
 * manual-time carve — resolves open ends through this one rule.
 *
 * Pure: the evidence is loaded by the caller (see the API's
 * `loadEntryLiveEvidence`) and handed in.
 */

const MIN = 60 * 1000;

export const LIVE_HEARTBEAT_FRESH_MS = 3 * MIN;
export const CLIENT_CLOCK_SKEW_MS = 2 * MIN;
export const OPEN_SEGMENT_FRESH_MS = LIVE_HEARTBEAT_FRESH_MS;

export interface EntryLiveEvidence {
  latestStoredProofAt: Date | null;
  latestHeartbeatAt: Date | null;
}

export type EntryLiveEvidenceMap = Map<string, EntryLiveEvidence>;

export interface TimerLifecycleEvidence {
  trackingProtocolVersion?: number | null;
  lastProvenAt?: Date | null;
  leaseExpiresAt?: Date | null;
}

export function heartbeatIsFresh(
  evidence: EntryLiveEvidence | null | undefined,
  now: Date,
  notBefore?: Date,
): boolean {
  const heartbeatMs = evidence?.latestHeartbeatAt?.getTime();
  return heartbeatMs !== undefined
    && heartbeatMs <= now.getTime()
    && heartbeatMs >= now.getTime() - LIVE_HEARTBEAT_FRESH_MS
    && (notBefore === undefined || heartbeatMs >= notBefore.getTime());
}

/** A client-observed instant, bounded by when the server actually received it. */
export function trustedObservedAt(input: {
  observedAt: Date;
  receivedAt: Date;
  now: Date;
}): Date | null {
  const observedMs = input.observedAt.getTime();
  const receivedMs = input.receivedAt.getTime();
  const nowMs = input.now.getTime();
  if (!Number.isFinite(observedMs) || !Number.isFinite(receivedMs)) return null;
  if (observedMs > receivedMs + CLIENT_CLOCK_SKEW_MS || observedMs > nowMs + CLIENT_CLOCK_SKEW_MS) {
    return null;
  }
  return new Date(Math.min(observedMs, receivedMs, nowMs));
}

/**
 * The effective end of one segment. `null` means "live — count it to now".
 */
export function effectiveSegmentEnd(input: {
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

/**
 * Effective ends for every segment of one entry, in input order. A segment left
 * open behind a later one ends where the next begins (or where the entry ended);
 * only the trailing open segment consults the live evidence.
 */
export function effectiveEntrySegmentEnds(input: {
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

    resolved[index] = effectiveSegmentEnd({
      startedAt: segment.startedAt,
      endedAt: null,
      now: input.now,
      evidence: input.evidence,
      lifecycle: input.lifecycle,
    });
  }

  return resolved;
}
