import { describe, expect, it } from 'vitest';
import { resolveEffectiveSegmentEnd } from './openSegmentEvidence';

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

  it('retains activity-sample fallback for legacy entries', () => {
    expect(resolveEffectiveSegmentEnd({
      startedAt,
      endedAt: null,
      now,
      latestSampleAt: new Date('2026-07-11T09:30:00.000Z'),
    })?.toISOString()).toBe('2026-07-11T09:31:00.000Z');
  });
});
