import { describe, expect, it } from 'vitest';
import { resolveUnfundedLeaveDays } from './leaveFunding';

const U = 'u1';
const accrual = (effectiveOn: string, days = 1) => ({ userId: U, effectiveOn, days });
const day = (date: string, cost = 1) => ({ userId: U, date, cost });

function unfunded(result: ReturnType<typeof resolveUnfundedLeaveDays>): string[] {
  return [...(result.get(U) ?? [])].sort();
}

describe('resolveUnfundedLeaveDays', () => {
  it('funds a day when the balance covers it', () => {
    const out = resolveUnfundedLeaveDays({
      credits: [accrual('2026-08-01')],
      leaveDays: [day('2026-08-10')],
      since: '2026-08',
    });
    expect(unfunded(out)).toEqual([]);
  });

  it('marks the day past the balance, and only that day', () => {
    const out = resolveUnfundedLeaveDays({
      credits: [accrual('2026-08-01')],
      leaveDays: [day('2026-08-10'), day('2026-08-11'), day('2026-08-12')],
      since: '2026-08',
    });
    expect(unfunded(out)).toEqual(['2026-08-11', '2026-08-12']);
  });

  it('spends in date order, so the earlier day is the one that gets paid', () => {
    const out = resolveUnfundedLeaveDays({
      credits: [accrual('2026-08-01')],
      // Handed in backwards on purpose: the answer must not depend on input order.
      leaveDays: [day('2026-08-20'), day('2026-08-05')],
      since: '2026-08',
    });
    expect(unfunded(out)).toEqual(['2026-08-20']);
  });

  it('lets an accrual dated the 1st pay for leave taken on the 1st', () => {
    const out = resolveUnfundedLeaveDays({
      credits: [accrual('2026-08-01')],
      leaveDays: [day('2026-08-01')],
      since: '2026-08',
    });
    expect(unfunded(out)).toEqual([]);
  });

  it('does not let a later accrual pay for an earlier day', () => {
    const out = resolveUnfundedLeaveDays({
      credits: [accrual('2026-09-01')],
      leaveDays: [day('2026-08-15')],
      since: '2026-08',
    });
    expect(unfunded(out)).toEqual(['2026-08-15']);
  });

  it('carries an unspent balance into the next month', () => {
    const out = resolveUnfundedLeaveDays({
      credits: [accrual('2026-08-01'), accrual('2026-09-01')],
      leaveDays: [day('2026-09-10'), day('2026-09-11')],
      since: '2026-08',
    });
    expect(unfunded(out)).toEqual([]);
  });

  it('handles half days', () => {
    const out = resolveUnfundedLeaveDays({
      credits: [accrual('2026-08-01')],
      leaveDays: [day('2026-08-05', 0.5), day('2026-08-06', 0.5), day('2026-08-07', 0.5)],
      since: '2026-08',
    });
    expect(unfunded(out)).toEqual(['2026-08-07']);
  });

  it('always funds a day that costs nothing', () => {
    // A weekly off or holiday inside a leave range is priced at zero by the
    // calendar, so it must never be called unpaid.
    const out = resolveUnfundedLeaveDays({
      credits: [],
      leaveDays: [day('2026-08-05', 0)],
      since: '2026-08',
    });
    expect(unfunded(out)).toEqual([]);
  });

  it('leaves days before the ledger start alone', () => {
    const out = resolveUnfundedLeaveDays({
      credits: [],
      leaveDays: [day('2026-07-20'), day('2026-07-21')],
      since: '2026-08',
    });
    expect(unfunded(out)).toEqual([]);
  });

  it('does not let pre-start leave eat the balance that funds August', () => {
    const out = resolveUnfundedLeaveDays({
      credits: [accrual('2026-08-01')],
      leaveDays: [day('2026-07-20'), day('2026-07-21'), day('2026-08-04')],
      since: '2026-08',
    });
    expect(unfunded(out)).toEqual([]);
  });

  it('starts a late joiner at their own accrual date, not the workspace floor', () => {
    const out = resolveUnfundedLeaveDays({
      credits: [accrual('2026-09-01')],
      leaveDays: [day('2026-08-20'), day('2026-09-05')],
      since: '2026-08',
      accrualStartFor: { [U]: '2026-09-01' },
    });
    expect(unfunded(out)).toEqual([]);
  });

  it('lets a negative adjustment push a day out of funding', () => {
    const out = resolveUnfundedLeaveDays({
      credits: [accrual('2026-08-01'), accrual('2026-08-02', -1)],
      leaveDays: [day('2026-08-10')],
      since: '2026-08',
    });
    expect(unfunded(out)).toEqual(['2026-08-10']);
  });

  it('keeps users apart', () => {
    const out = resolveUnfundedLeaveDays({
      credits: [{ userId: 'a', effectiveOn: '2026-08-01', days: 1 }],
      leaveDays: [
        { userId: 'a', date: '2026-08-10', cost: 1 },
        { userId: 'b', date: '2026-08-10', cost: 1 },
      ],
      since: '2026-08',
    });
    expect([...(out.get('a') ?? [])]).toEqual([]);
    expect([...(out.get('b') ?? [])]).toEqual(['2026-08-10']);
  });

  it('applies the rule from the very beginning when no floor is set', () => {
    const out = resolveUnfundedLeaveDays({
      credits: [],
      leaveDays: [day('2020-01-01')],
    });
    expect(unfunded(out)).toEqual(['2020-01-01']);
  });
});
