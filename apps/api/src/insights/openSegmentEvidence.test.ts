import { describe, expect, it } from 'vitest';
import { resolveEffectiveEntrySegmentEnds, resolveEffectiveSegmentEnd } from './openSegmentEvidence';

const now = new Date('2026-07-11T10:00:00.000Z');
const startedAt = new Date('2026-07-11T09:00:00.000Z');

describe('resolveEffectiveSegmentEnd', () => {
  it('keeps a protocol-v2 segment live only while its lease is valid', () => {
    expect(resolveEffectiveSegmentEnd({
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
    expect(resolveEffectiveSegmentEnd({
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
    expect(resolveEffectiveSegmentEnd({
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
    expect(resolveEffectiveSegmentEnd({
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
    expect(resolveEffectiveSegmentEnd({
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
    expect(resolveEffectiveSegmentEnd({
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
    expect(resolveEffectiveSegmentEnd({
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

describe('resolveEffectiveEntrySegmentEnds', () => {
  it('applies entry proof only to the final open segment', () => {
    const segments = [
      { startedAt, endedAt: null },
      { startedAt: new Date('2026-07-11T09:30:00.000Z'), endedAt: null },
    ];
    const ends = resolveEffectiveEntrySegmentEnds({
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
