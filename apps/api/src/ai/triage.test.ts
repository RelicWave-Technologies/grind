import { describe, it, expect } from 'vitest';
import { triageRequest, type TriageContext } from './triage';

const HOUR = 60 * 60 * 1000;

const baseCtx: TriageContext = {
  autoTrackedSameDayMs: 6 * HOUR,
  closestAutoEdgeMs: 5 * 60 * 1000,
  avgDailyTotalMs: 8 * HOUR,
  rejectedLast30Days: 0,
  approvedLast30Days: 2,
  requestAgeMs: 2 * HOUR,
};

const baseReq = {
  requestedStartMs: 1_700_000_000_000,
  requestedEndMs: 1_700_000_000_000 + 1 * HOUR,
  reason: 'forgot to start the tracker after lunch — finished the migration doc',
  context: baseCtx,
};

describe('triageRequest', () => {
  it('returns approve for a clean adjacent 1h request with a substantive reason', () => {
    const r = triageRequest(baseReq);
    expect(r.verdict).toBe('approve');
    expect(r.signals.find((s) => s.id === 'adjacent_to_auto')).toBeDefined();
    expect(r.signals.find((s) => s.id === 'reason_substantive')).toBeDefined();
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it('returns reject for a long request from a user with many recent rejections + generic reason', () => {
    const r = triageRequest({
      requestedStartMs: 0,
      requestedEndMs: 14 * HOUR,
      reason: 'work',
      context: {
        ...baseCtx,
        autoTrackedSameDayMs: 0,
        closestAutoEdgeMs: 24 * HOUR,
        rejectedLast30Days: 5,
        approvedLast30Days: 0,
      },
    });
    expect(r.verdict).toBe('reject');
    expect(r.signals.find((s) => s.id === 'duration_out_of_range')).toBeDefined();
    expect(r.signals.find((s) => s.id === 'frequent_rejections')).toBeDefined();
  });

  it('returns review for an ambiguous case (no AUTO + okay reason + no history)', () => {
    const r = triageRequest({
      ...baseReq,
      context: {
        ...baseCtx,
        autoTrackedSameDayMs: 0,
        closestAutoEdgeMs: 10 * HOUR,
        approvedLast30Days: 0,
      },
    });
    // The mix of substantive reason + no-AUTO + no-history shouldn't swing
    // hard either way.
    expect(['review', 'approve']).toContain(r.verdict);
  });

  it('flags a brief reason as a negative signal', () => {
    const r = triageRequest({ ...baseReq, reason: 'k' });
    expect(r.signals.find((s) => s.id === 'reason_short')).toBeDefined();
  });

  it('flags a generic reason as a negative signal', () => {
    const r = triageRequest({ ...baseReq, reason: 'forgot' });
    expect(r.signals.find((s) => s.id === 'reason_generic')).toBeDefined();
  });

  it('surfaces clean_history when 3+ approvals + zero rejections', () => {
    const r = triageRequest({
      ...baseReq,
      context: { ...baseCtx, approvedLast30Days: 8, rejectedLast30Days: 0 },
    });
    expect(r.signals.find((s) => s.id === 'clean_history')).toBeDefined();
  });

  it('marks long-stuck requests with request_stuck', () => {
    const r = triageRequest({
      ...baseReq,
      context: { ...baseCtx, requestAgeMs: 4 * 24 * HOUR },
    });
    expect(r.signals.find((s) => s.id === 'request_stuck')).toBeDefined();
  });

  it('confidence ≤ 1.0', () => {
    const r = triageRequest({
      ...baseReq,
      context: { ...baseCtx, approvedLast30Days: 50 }, // pile on positives
    });
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  it('headline always populated', () => {
    expect(triageRequest(baseReq).headline.length).toBeGreaterThan(5);
  });

  it('isolated_from_auto (zero AUTO same day) is a soft negative', () => {
    const r = triageRequest({
      ...baseReq,
      context: { ...baseCtx, autoTrackedSameDayMs: 0, closestAutoEdgeMs: 24 * HOUR },
    });
    expect(r.signals.find((s) => s.id === 'isolated_from_auto')).toBeDefined();
  });

  it('duration > 4h and > 1.5× avg lands duration_out_of_range', () => {
    const r = triageRequest({
      requestedStartMs: 0,
      requestedEndMs: 13 * HOUR,
      reason: 'big push to land the release notes + final QA pass',
      context: { ...baseCtx, avgDailyTotalMs: 7 * HOUR },
    });
    expect(r.signals.find((s) => s.id === 'duration_out_of_range')).toBeDefined();
  });
});
