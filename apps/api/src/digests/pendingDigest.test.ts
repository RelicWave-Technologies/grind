import { describe, it, expect } from 'vitest';
import {
  buildPendingDigests,
  formatDigestPlainText,
  DEFAULT_STUCK_THRESHOLD_MS,
  type PendingRequestInput,
} from './pendingDigest';

const HOUR = 60 * 60 * 1000;

const NOW = 1_700_000_000_000;

function req(opts: Partial<PendingRequestInput> & Pick<PendingRequestInput, 'id' | 'requesterId' | 'requesterName' | 'createdAtMs'>): PendingRequestInput {
  return {
    requestedStart: opts.requestedStart ?? NOW - 8 * HOUR,
    requestedEnd: opts.requestedEnd ?? NOW - 7 * HOUR,
    approverId: opts.approverId ?? 'mgr_1',
    reason: opts.reason ?? 'reason',
    ...opts,
  };
}

describe('buildPendingDigests', () => {
  it('returns empty when no requests', () => {
    expect(buildPendingDigests([], { now: NOW })).toEqual([]);
  });

  it('groups requests by approver', () => {
    const digests = buildPendingDigests(
      [
        req({ id: 'r1', requesterId: 'u1', requesterName: 'Alice', approverId: 'mgr_1', createdAtMs: NOW - HOUR }),
        req({ id: 'r2', requesterId: 'u2', requesterName: 'Bob', approverId: 'mgr_2', createdAtMs: NOW - HOUR }),
        req({ id: 'r3', requesterId: 'u3', requesterName: 'Carol', approverId: 'mgr_1', createdAtMs: NOW - HOUR }),
      ],
      { now: NOW },
    );
    expect(digests).toHaveLength(2);
    const m1 = digests.find((d) => d.approverId === 'mgr_1');
    const m2 = digests.find((d) => d.approverId === 'mgr_2');
    expect(m1?.totalCount).toBe(2);
    expect(m2?.totalCount).toBe(1);
  });

  it('flags stuck items past the threshold', () => {
    const digests = buildPendingDigests(
      [
        req({ id: 'r1', requesterId: 'u1', requesterName: 'Alice', createdAtMs: NOW - 60 * HOUR }), // 60h stuck
        req({ id: 'r2', requesterId: 'u2', requesterName: 'Bob', createdAtMs: NOW - 1 * HOUR }), // 1h fresh
      ],
      { now: NOW },
    );
    expect(digests).toHaveLength(1);
    expect(digests[0]?.stuck.map((i) => i.requestId)).toEqual(['r1']);
    expect(digests[0]?.fresh.map((i) => i.requestId)).toEqual(['r2']);
  });

  it('uses custom threshold when provided', () => {
    const digests = buildPendingDigests(
      [req({ id: 'r1', requesterId: 'u1', requesterName: 'A', createdAtMs: NOW - 12 * HOUR })],
      { now: NOW, stuckThresholdMs: 6 * HOUR },
    );
    expect(digests[0]?.stuck).toHaveLength(1);
  });

  it('drops approvers with no items (empty managers are not spammed)', () => {
    // Two approvers but only mgr_1 has items.
    const digests = buildPendingDigests(
      [req({ id: 'r1', requesterId: 'u1', requesterName: 'A', approverId: 'mgr_1', createdAtMs: NOW - HOUR })],
      { now: NOW },
    );
    expect(digests.map((d) => d.approverId)).toEqual(['mgr_1']);
  });

  it('collapses null approverId under __unassigned__', () => {
    const digests = buildPendingDigests(
      [req({ id: 'r1', requesterId: 'u1', requesterName: 'A', approverId: null, createdAtMs: NOW - HOUR })],
      { now: NOW },
    );
    expect(digests).toHaveLength(1);
    expect(digests[0]?.approverId).toBe('__unassigned__');
  });

  it('sorts items by age desc within each digest', () => {
    const digests = buildPendingDigests(
      [
        req({ id: 'newest', requesterId: 'u1', requesterName: 'A', createdAtMs: NOW - 1 * HOUR }),
        req({ id: 'oldest', requesterId: 'u2', requesterName: 'B', createdAtMs: NOW - 70 * HOUR }),
        req({ id: 'middle', requesterId: 'u3', requesterName: 'C', createdAtMs: NOW - 60 * HOUR }),
      ],
      { now: NOW },
    );
    // 'oldest' (70h) and 'middle' (60h) are both stuck (>= 48h); newest (1h) is fresh.
    expect(digests[0]?.stuck.map((i) => i.requestId)).toEqual(['oldest', 'middle']);
    expect(digests[0]?.fresh.map((i) => i.requestId)).toEqual(['newest']);
  });

  it('sorts approvers by most-stuck first; ties broken by oldest age', () => {
    const digests = buildPendingDigests(
      [
        // mgr_1: 1 stuck (50h)
        req({ id: 'r1', requesterId: 'u1', requesterName: 'A', approverId: 'mgr_1', createdAtMs: NOW - 50 * HOUR }),
        // mgr_2: 2 stuck
        req({ id: 'r2', requesterId: 'u2', requesterName: 'B', approverId: 'mgr_2', createdAtMs: NOW - 70 * HOUR }),
        req({ id: 'r3', requesterId: 'u3', requesterName: 'C', approverId: 'mgr_2', createdAtMs: NOW - 60 * HOUR }),
        // mgr_3: 1 stuck (80h) — most stuck despite fewest count
        req({ id: 'r4', requesterId: 'u4', requesterName: 'D', approverId: 'mgr_3', createdAtMs: NOW - 80 * HOUR }),
      ],
      { now: NOW },
    );
    expect(digests.map((d) => d.approverId)).toEqual(['mgr_2', 'mgr_3', 'mgr_1']);
  });

  it('age clamps to zero if createdAt is in the future (clock skew)', () => {
    const digests = buildPendingDigests(
      [req({ id: 'r1', requesterId: 'u1', requesterName: 'A', createdAtMs: NOW + HOUR })],
      { now: NOW },
    );
    expect(digests[0]?.fresh[0]?.ageMs).toBe(0);
    expect(digests[0]?.fresh[0]?.isStuck).toBe(false);
  });

  it('exactly at threshold counts as stuck', () => {
    const digests = buildPendingDigests(
      [req({ id: 'r1', requesterId: 'u1', requesterName: 'A', createdAtMs: NOW - DEFAULT_STUCK_THRESHOLD_MS })],
      { now: NOW },
    );
    expect(digests[0]?.stuck).toHaveLength(1);
  });

  it('oldestAgeMs reflects the oldest item per approver', () => {
    const digests = buildPendingDigests(
      [
        req({ id: 'r1', requesterId: 'u1', requesterName: 'A', createdAtMs: NOW - 5 * HOUR }),
        req({ id: 'r2', requesterId: 'u2', requesterName: 'B', createdAtMs: NOW - 50 * HOUR }),
      ],
      { now: NOW },
    );
    expect(digests[0]?.oldestAgeMs).toBe(50 * HOUR);
  });
});

describe('formatDigestPlainText', () => {
  it('reports both stuck and fresh counts', () => {
    const digest = buildPendingDigests(
      [
        req({ id: 'r1', requesterId: 'u1', requesterName: 'Alice', createdAtMs: NOW - 60 * HOUR }),
        req({ id: 'r2', requesterId: 'u2', requesterName: 'Bob', createdAtMs: NOW - 2 * HOUR }),
      ],
      { now: NOW },
    )[0]!;
    const text = formatDigestPlainText(digest);
    expect(text).toContain('1 stuck approval');
    expect(text).toContain('1 pending approval');
    expect(text).toContain('Alice');
    expect(text).toContain('Bob');
  });

  it('truncates long reasons', () => {
    const longReason = 'x'.repeat(200);
    const digest = buildPendingDigests(
      [req({ id: 'r1', requesterId: 'u1', requesterName: 'A', reason: longReason, createdAtMs: NOW - HOUR })],
      { now: NOW },
    )[0]!;
    const text = formatDigestPlainText(digest);
    // Ends with the ellipsis truncation marker.
    expect(text).toContain('…');
    expect(text.length).toBeLessThan(longReason.length);
  });

  it('appends a dashboard URL when given', () => {
    const digest = buildPendingDigests(
      [req({ id: 'r1', requesterId: 'u1', requesterName: 'A', createdAtMs: NOW - HOUR })],
      { now: NOW },
    )[0]!;
    const text = formatDigestPlainText(digest, { dashboardUrl: 'https://grind.example.com/approvals' });
    expect(text).toContain('https://grind.example.com/approvals');
  });

  it('caps to 5 items and notes the remainder', () => {
    const reqs = Array.from({ length: 7 }, (_, i) =>
      req({ id: `r${i}`, requesterId: `u${i}`, requesterName: `Person ${i}`, createdAtMs: NOW - HOUR }),
    );
    const digest = buildPendingDigests(reqs, { now: NOW })[0]!;
    const text = formatDigestPlainText(digest);
    expect(text).toContain('and 2 more');
  });
});
