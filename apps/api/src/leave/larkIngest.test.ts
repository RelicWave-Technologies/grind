import { describe, it, expect } from 'vitest';
import { portionFor, __endDateOfForTests as endDateOf } from './larkIngest';
import { decisionFromLarkStatus } from './approvalGateway';

/**
 * The two pure decisions in the mirror: which half of a day Lark meant, and
 * what its status means to us. Everything else in the ingester is HTTP and
 * upserts, covered by the end-to-end suite.
 */

/** IST, as Date.prototype.getTimezoneOffset reports it. */
const IST = -330;

describe('portionFor — Lark has no portion field, only times', () => {
  /** Build an instant from an IST wall-clock hour. */
  const at = (hour: number) => Date.UTC(2026, 7, 17, hour, 0) + IST * 60_000;

  it('treats a full day as FULL regardless of when it starts', () => {
    expect(portionFor(1, at(9), IST)).toBe('FULL');
    expect(portionFor(1, at(14), IST)).toBe('FULL');
  });

  it('treats anything longer than a day as FULL', () => {
    expect(portionFor(3, at(9), IST)).toBe('FULL');
  });

  it('reads a morning half-day as the first half', () => {
    // A real "Half Day AM" arrives with a 09:00 IST start.
    expect(portionFor(0.5, at(9), IST)).toBe('FIRST_HALF');
    expect(portionFor(0.5, at(11), IST)).toBe('FIRST_HALF');
  });

  it('reads an afternoon half-day as the second half', () => {
    // And a "Half Day PM" with a 13:30 IST start.
    expect(portionFor(0.5, at(13), IST)).toBe('SECOND_HALF');
    expect(portionFor(0.5, at(17), IST)).toBe('SECOND_HALF');
  });

  it('puts midday exactly on the afternoon side', () => {
    expect(portionFor(0.5, at(12), IST)).toBe('SECOND_HALF');
  });

  it('judges the half in the workspace zone, not UTC', () => {
    // 09:00 IST is 03:30 UTC — reading this in UTC would still say morning, so
    // use a case where the two disagree: 20:00 UTC is 01:30 IST next day.
    const utcEvening = Date.UTC(2026, 7, 17, 20, 0);
    expect(portionFor(0.5, utcEvening, IST)).toBe('FIRST_HALF');
    expect(portionFor(0.5, utcEvening, 0)).toBe('SECOND_HALF');
  });
});

describe('decisionFromLarkStatus', () => {
  it('maps the outcomes we act on', () => {
    expect(decisionFromLarkStatus('APPROVED')).toBe('APPROVED');
    expect(decisionFromLarkStatus('REJECTED')).toBe('REJECTED');
    expect(decisionFromLarkStatus('PENDING')).toBe('PENDING');
  });

  it('treats withdrawn and deleted alike — nobody will decide either', () => {
    expect(decisionFromLarkStatus('CANCELED')).toBe('CANCELLED');
    expect(decisionFromLarkStatus('DELETED')).toBe('CANCELLED');
  });

  it('never lets an unreadable status masquerade as still waiting', () => {
    expect(decisionFromLarkStatus('SOMETHING_NEW')).toBe('UNKNOWN');
    expect(decisionFromLarkStatus(undefined)).toBe('UNKNOWN');
  });
});


describe('endDateOf — Lark\'s end is exclusive', () => {
  const IST = -330;
  /** An IST wall-clock instant. */
  const ist = (y: number, m: number, d: number, h = 0) => Date.UTC(y, m - 1, d, h) + IST * 60_000;

  it('a one-day leave ending at the next midnight covers only its own day', () => {
    // Real shape: interval 1, IST 24 Jul 00:00 -> 25 Jul 00:00.
    expect(endDateOf(ist(2026, 7, 25), IST)).toBe('2026-07-24');
  });

  it('a two-day leave covers two days, not three', () => {
    // interval 2, IST 23 Jul 00:00 -> 25 Jul 00:00.
    expect(endDateOf(ist(2026, 7, 25), IST)).toBe('2026-07-24');
  });

  it('a nine-day leave lands on the ninth day', () => {
    // interval 9, IST 27 Jul 00:00 -> 5 Aug 00:00.
    expect(endDateOf(ist(2026, 8, 5), IST)).toBe('2026-08-04');
  });

  it('a morning half-day ending at noon stays on its own day', () => {
    expect(endDateOf(ist(2026, 7, 22, 12), IST)).toBe('2026-07-22');
  });

  it('an afternoon half-day ending at the next midnight stays on its own day', () => {
    expect(endDateOf(ist(2026, 7, 22, 24), IST)).toBe('2026-07-22');
  });

  it('crosses a month boundary correctly', () => {
    expect(endDateOf(ist(2026, 9, 1), IST)).toBe('2026-08-31');
  });

  it('respects the workspace offset rather than UTC', () => {
    // Midnight IST is 18:30 UTC the previous day; read in UTC this would give
    // a different — and wrong — last day.
    expect(endDateOf(ist(2026, 7, 25), IST)).toBe('2026-07-24');
    expect(endDateOf(Date.UTC(2026, 6, 25), 0)).toBe('2026-07-24');
  });
});
