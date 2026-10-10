import { describe, expect, it } from 'vitest';
import { effectiveEntrySegmentEnds, effectiveSegmentEnd, heartbeatIsFresh, trustedObservedAt } from './evidence';

const now = new Date('2026-07-11T10:00:00.000Z');
const startedAt = new Date('2026-07-11T09:00:00.000Z');

describe('effectiveSegmentEnd', () => {
  it('keeps a protocol-v2 segment live only while its lease is valid', () => {
    expect(effectiveSegmentEnd({
      startedAt,
      endedAt: null,
      now,
      lifecycle: {
        trackingProtocolVersion: 2,
        lastProvenAt: new Date('2026-07-11T09:59:00.000Z'),
        leaseExpiresAt: new Date('2026-07-11T10:02:00.000Z'),
      },
    })).toBeNull();
  });

  it('caps an expired protocol-v2 segment at its last proof', () => {
    expect(effectiveSegmentEnd({
      startedAt,
      endedAt: null,
      now,
      lifecycle: {
        trackingProtocolVersion: 2,
        lastProvenAt: new Date('2026-07-11T09:56:00.000Z'),
        leaseExpiresAt: new Date('2026-07-11T09:59:00.000Z'),
      },
    })?.toISOString()).toBe('2026-07-11T09:56:00.000Z');
  });

  it('caps a legacy entry at its latest server-bounded stored proof', () => {
    expect(effectiveSegmentEnd({
      startedAt,
      endedAt: null,
      now,
      evidence: {
        latestStoredProofAt: new Date('2026-07-11T09:31:00.000Z'),
        latestHeartbeatAt: null,
      },
    })?.toISOString()).toBe('2026-07-11T09:31:00.000Z');
  });

  it('caps a legacy segment at a fresh screenshot until a matching heartbeat proves it is still live', () => {
    expect(effectiveSegmentEnd({
      startedAt,
      endedAt: null,
      now,
      evidence: {
        latestStoredProofAt: new Date('2026-07-11T09:58:00.000Z'),
        latestHeartbeatAt: null,
      },
    })?.toISOString()).toBe('2026-07-11T09:58:00.000Z');
  });

  it('caps a legacy segment at its last screenshot rather than creating a false live interval', () => {
    expect(effectiveSegmentEnd({
      startedAt,
      endedAt: null,
      now,
      evidence: {
        latestStoredProofAt: new Date('2026-07-11T09:42:00.000Z'),
        latestHeartbeatAt: null,
      },
    })?.toISOString()).toBe('2026-07-11T09:42:00.000Z');
  });

  it('accepts a heartbeat only as entry-specific proof supplied by the caller', () => {
    expect(effectiveSegmentEnd({
      startedAt,
      endedAt: null,
      now,
      evidence: {
        latestStoredProofAt: null,
        latestHeartbeatAt: new Date('2026-07-11T09:59:00.000Z'),
      },
    })).toBeNull();
  });

  it('does not treat a heartbeat older than three minutes as live', () => {
    expect(effectiveSegmentEnd({
      startedAt,
      endedAt: null,
      now,
      evidence: {
        latestStoredProofAt: null,
        latestHeartbeatAt: new Date('2026-07-11T09:56:59.000Z'),
      },
    })?.toISOString()).toBe('2026-07-11T09:56:59.000Z');
  });
});

describe('effectiveEntrySegmentEnds', () => {
  it('applies entry proof only to the final open segment', () => {
    const segments = [
      { startedAt, endedAt: null },
      { startedAt: new Date('2026-07-11T09:30:00.000Z'), endedAt: null },
    ];
    const ends = effectiveEntrySegmentEnds({
      segments,
      now,
      evidence: {
        latestStoredProofAt: new Date('2026-07-11T09:50:00.000Z'),
        latestHeartbeatAt: null,
      },
    });

    expect(ends.map((end) => end?.toISOString())).toEqual([
      '2026-07-11T09:30:00.000Z',
      '2026-07-11T09:50:00.000Z',
    ]);
  });
});

describe('trustedObservedAt', () => {
  const now = new Date('2026-07-13T10:00:00.000Z');

  it('rejects proof beyond the allowed client clock skew', () => {
    expect(trustedObservedAt({
      observedAt: new Date('2026-07-13T10:03:00.000Z'),
      receivedAt: now,
      now,
    })).toBeNull();
  });

  it('never proves later than the server receipt time', () => {
    expect(trustedObservedAt({
      observedAt: new Date('2026-07-13T10:01:00.000Z'),
      receivedAt: now,
      now: new Date('2026-07-13T10:01:30.000Z'),
    })?.toISOString()).toBe(now.toISOString());
  });
});

describe('heartbeatIsFresh', () => {
  const now = new Date('2026-07-13T10:00:00.000Z');

  it('accepts the three-minute boundary and rejects older or future heartbeats', () => {
    const evidenceAt = (timestamp: string) => ({
      latestStoredProofAt: null,
      latestHeartbeatAt: new Date(timestamp),
    });

    expect(heartbeatIsFresh(evidenceAt('2026-07-13T09:57:00.000Z'), now)).toBe(true);
    expect(heartbeatIsFresh(evidenceAt('2026-07-13T09:56:59.999Z'), now)).toBe(false);
    expect(heartbeatIsFresh(evidenceAt('2026-07-13T10:00:00.001Z'), now)).toBe(false);
    expect(heartbeatIsFresh(
      evidenceAt('2026-07-13T09:59:00.000Z'),
      now,
      new Date('2026-07-13T09:59:00.001Z'),
    )).toBe(false);
  });
});
