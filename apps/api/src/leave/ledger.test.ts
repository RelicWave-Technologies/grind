import { describe, it, expect } from 'vitest';
import {
  projectBalance,
  accrualsDue,
  accrualSourceKey,
  consumptionSourceKey,
  reversalSourceKey,
  affordability,
  monthOf,
  nextMonth,
  firstOfMonth,
  type LeaveLedgerEntry,
} from './ledger';

const POLICY = {
  monthlyAccrualDays: 1,
  accrueOnJoinMonth: true,
  carryForward: true,
  carryForwardCapDays: null,
};

describe('projectBalance — the statement is the answer', () => {
  it('sums an empty ledger to zero', () => {
    expect(projectBalance([]).balanceDays).toBe(0);
  });

  it('reproduces the worked example end to end', () => {
    const entries: LeaveLedgerEntry[] = [
      { kind: 'ACCRUAL', days: 1, effectiveOn: '2026-01-01' },
      { kind: 'ACCRUAL', days: 1, effectiveOn: '2026-02-01' },
      { kind: 'CONSUMPTION', days: -0.5, effectiveOn: '2026-02-14' },
      { kind: 'ACCRUAL', days: 1, effectiveOn: '2026-03-01' },
      { kind: 'CONSUMPTION', days: -2, effectiveOn: '2026-03-10' },
      { kind: 'ADJUSTMENT', days: 1, effectiveOn: '2026-03-20', reason: 'comp for weekend release' },
      { kind: 'ADJUSTMENT', days: 0.5, effectiveOn: '2026-03-22', reason: 'leave cancelled' },
    ];
    const b = projectBalance(entries);
    expect(b.balanceDays).toBe(2);
    expect(b.accruedDays).toBe(3);
    expect(b.consumedDays).toBe(2.5);
    expect(b.adjustedDays).toBe(1.5);
  });

  it('carry-forward needs no code — nothing resets across a year end', () => {
    const entries: LeaveLedgerEntry[] = [
      { kind: 'ACCRUAL', days: 1, effectiveOn: '2026-11-01' },
      { kind: 'ACCRUAL', days: 1, effectiveOn: '2026-12-01' },
      { kind: 'ACCRUAL', days: 1, effectiveOn: '2027-01-01' },
    ];
    expect(projectBalance(entries).balanceDays).toBe(3);
  });

  it('asOf makes a past month reproducible from today', () => {
    const entries: LeaveLedgerEntry[] = [
      { kind: 'ACCRUAL', days: 1, effectiveOn: '2026-08-01' },
      { kind: 'CONSUMPTION', days: -1, effectiveOn: '2026-09-05' },
    ];
    expect(projectBalance(entries, '2026-08-31').balanceDays).toBe(1);
    expect(projectBalance(entries).balanceDays).toBe(0);
  });

  it('an entry dated exactly on asOf is included', () => {
    const entries: LeaveLedgerEntry[] = [{ kind: 'ACCRUAL', days: 1, effectiveOn: '2026-08-31' }];
    expect(projectBalance(entries, '2026-08-31').balanceDays).toBe(1);
  });

  it('halves stay exact over many entries', () => {
    const entries: LeaveLedgerEntry[] = Array.from({ length: 21 }, () => ({
      kind: 'CONSUMPTION' as const,
      days: -0.5,
      effectiveOn: '2026-08-01',
    }));
    expect(projectBalance(entries).balanceDays).toBe(-10.5);
  });

  it('never reports a balance of negative zero', () => {
    // Negating zero gives -0, which compares unequal to 0 and reads as a bug to
    // anyone who sees it on their balance.
    const b = projectBalance([{ kind: 'CONSUMPTION', days: 0, effectiveOn: '2026-08-01' }]);
    expect(Object.is(b.consumedDays, -0)).toBe(false);
    expect(Object.is(projectBalance([]).balanceDays, -0)).toBe(false);
  });

  it('reports consumption as a positive number', () => {
    const b = projectBalance([{ kind: 'CONSUMPTION', days: -1.5, effectiveOn: '2026-08-01' }]);
    expect(b.consumedDays).toBe(1.5);
    expect(b.balanceDays).toBe(-1.5);
  });
});

describe('accrualsDue — a missed month self-heals', () => {
  it('derives one entry per month from joining to asOf', () => {
    const due = accrualsDue({ userId: 'u1', joinedOn: '2026-01-10', asOf: '2026-03-15', policy: POLICY });
    expect(due.map((d) => d.month)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(due.every((d) => d.days === 1)).toBe(true);
  });

  it('dates each entry to the first of its month', () => {
    const due = accrualsDue({ userId: 'u1', joinedOn: '2026-01-10', asOf: '2026-02-01', policy: POLICY });
    expect(due.map((d) => d.effectiveOn)).toEqual(['2026-01-01', '2026-02-01']);
  });

  it('keys every entry so a retry collides instead of double-crediting', () => {
    const due = accrualsDue({ userId: 'u1', joinedOn: '2026-01-10', asOf: '2026-02-15', policy: POLICY });
    expect(due.map((d) => d.sourceKey)).toEqual(['accrual:u1:2026-01', 'accrual:u1:2026-02']);
    // Re-deriving is stable — that is what makes the upsert idempotent.
    const again = accrualsDue({ userId: 'u1', joinedOn: '2026-01-10', asOf: '2026-02-15', policy: POLICY });
    expect(again.map((d) => d.sourceKey)).toEqual(due.map((d) => d.sourceKey));
  });

  it('re-deriving after a gap fills the gap rather than skipping it', () => {
    // Simulate a cron that never ran for February.
    const written = new Set(['accrual:u1:2026-01', 'accrual:u1:2026-03']);
    const due = accrualsDue({ userId: 'u1', joinedOn: '2026-01-01', asOf: '2026-03-31', policy: POLICY });
    const missing = due.filter((d) => !written.has(d.sourceKey));
    expect(missing.map((d) => d.month)).toEqual(['2026-02']);
  });

  it('skips the joining month when policy says so', () => {
    const due = accrualsDue({
      userId: 'u1',
      joinedOn: '2026-01-28',
      asOf: '2026-03-01',
      policy: { ...POLICY, accrueOnJoinMonth: false },
    });
    expect(due.map((d) => d.month)).toEqual(['2026-02', '2026-03']);
  });

  it('accrues nothing before the join date', () => {
    expect(accrualsDue({ userId: 'u1', joinedOn: '2026-05-01', asOf: '2026-01-01', policy: POLICY })).toEqual([]);
  });

  it('accrues nothing when the grant is zero', () => {
    const due = accrualsDue({ userId: 'u1', joinedOn: '2026-01-01', asOf: '2026-12-31', policy: { ...POLICY, monthlyAccrualDays: 0 } });
    expect(due).toEqual([]);
  });

  it('supports a half-day monthly grant', () => {
    const due = accrualsDue({ userId: 'u1', joinedOn: '2026-01-01', asOf: '2026-02-01', policy: { ...POLICY, monthlyAccrualDays: 0.5 } });
    expect(due.map((d) => d.days)).toEqual([0.5, 0.5]);
    expect(projectBalance(due.map((d) => ({ kind: 'ACCRUAL' as const, days: d.days, effectiveOn: d.effectiveOn }))).balanceDays).toBe(1);
  });

  it('crosses a year boundary', () => {
    const due = accrualsDue({ userId: 'u1', joinedOn: '2026-11-01', asOf: '2027-01-01', policy: POLICY });
    expect(due.map((d) => d.month)).toEqual(['2026-11', '2026-12', '2027-01']);
  });
});

describe('source keys', () => {
  it('ties consumption to the request that caused it', () => {
    expect(consumptionSourceKey('req-1')).toBe('leave:req-1');
  });

  it('gives a reversal its own key so it cannot collide with the charge', () => {
    expect(reversalSourceKey('req-1')).not.toBe(consumptionSourceKey('req-1'));
  });

  it('accrual keys are per user per month', () => {
    expect(accrualSourceKey('u1', '2026-08')).toBe('accrual:u1:2026-08');
  });
});

describe('affordability — checked at approval, not only at submission', () => {
  it('allows a request the balance covers', () => {
    const a = affordability({ balanceDays: 2, chargedDays: 1.5, allowNegativeBalance: false });
    expect(a.sufficient).toBe(true);
    expect(a.balanceAfterDays).toBe(0.5);
    expect(a.shortfallDays).toBe(0);
  });

  it('rejects balance 1.0 against a 3.0 request and names the shortfall', () => {
    const a = affordability({ balanceDays: 1, chargedDays: 3, allowNegativeBalance: false });
    expect(a.sufficient).toBe(false);
    expect(a.shortfallDays).toBe(2);
    expect(a.balanceAfterDays).toBe(-2);
  });

  it('permits going negative when policy allows it', () => {
    const a = affordability({ balanceDays: 1, chargedDays: 3, allowNegativeBalance: true });
    expect(a.sufficient).toBe(true);
    expect(a.balanceAfterDays).toBe(-2);
  });

  it('spending the balance to exactly zero is sufficient', () => {
    expect(affordability({ balanceDays: 1.5, chargedDays: 1.5, allowNegativeBalance: false }).sufficient).toBe(true);
  });

  it('two pending requests each look affordable alone — which is why approval re-checks', () => {
    const balance = 1;
    expect(affordability({ balanceDays: balance, chargedDays: 1, allowNegativeBalance: false }).sufficient).toBe(true);
    // After the first is approved the balance is 0, and the second no longer fits.
    expect(affordability({ balanceDays: 0, chargedDays: 1, allowNegativeBalance: false }).sufficient).toBe(false);
  });
});

describe('month helpers', () => {
  it('monthOf truncates a date', () => expect(monthOf('2026-08-17')).toBe('2026-08'));
  it('firstOfMonth expands a month', () => expect(firstOfMonth('2026-08')).toBe('2026-08-01'));
  it('nextMonth rolls a year', () => expect(nextMonth('2026-12')).toBe('2027-01'));
  it('nextMonth pads a single digit', () => expect(nextMonth('2026-08')).toBe('2026-09'));
});

describe('a workspace that starts counting partway through the year', () => {
  const policy = {
    monthlyAccrualDays: 1,
    accrueOnJoinMonth: true,
    carryForward: true,
    carryForwardCapDays: null,
    ledgerStartMonth: '2026-08',
  };

  it('accrues nothing for months before the start, however long ago they joined', () => {
    const due = accrualsDue({ userId: 'u1', joinedOn: '2026-03-10', asOf: '2026-09-15', policy });
    expect(due.map((d) => d.month)).toEqual(['2026-08', '2026-09']);
  });

  it('still starts at the joining month for somebody who joined after the start', () => {
    const due = accrualsDue({ userId: 'u1', joinedOn: '2026-09-04', asOf: '2026-09-15', policy });
    expect(due.map((d) => d.month)).toEqual(['2026-09']);
  });

  it('accrues from the joining month when no start is set', () => {
    const due = accrualsDue({
      userId: 'u1', joinedOn: '2026-06-10', asOf: '2026-08-15',
      policy: { ...policy, ledgerStartMonth: null },
    });
    expect(due.map((d) => d.month)).toEqual(['2026-06', '2026-07', '2026-08']);
  });

  it('leaves entries before the start out of the balance, without touching them', () => {
    const entries = [
      { kind: 'ACCRUAL' as const, days: 1, effectiveOn: '2026-07-01' },
      { kind: 'CONSUMPTION' as const, days: -2, effectiveOn: '2026-07-20' },
      { kind: 'ACCRUAL' as const, days: 1, effectiveOn: '2026-08-01' },
      { kind: 'CONSUMPTION' as const, days: -0.5, effectiveOn: '2026-08-14' },
    ];
    // Without the floor July's accrual and its bigger consumption both count.
    expect(projectBalance(entries).balanceDays).toBe(-0.5);
    // With it the balance opens at zero on 1 August: +1 accrued, 0.5 taken.
    const fromAugust = projectBalance(entries, undefined, '2026-08-01');
    expect(fromAugust.balanceDays).toBe(0.5);
    expect(fromAugust.accruedDays).toBe(1);
    expect(fromAugust.consumedDays).toBe(0.5);
  });

  it('applies the floor and the as-of cutoff together', () => {
    const entries = [
      { kind: 'ACCRUAL' as const, days: 1, effectiveOn: '2026-07-01' },
      { kind: 'ACCRUAL' as const, days: 1, effectiveOn: '2026-08-01' },
      { kind: 'ACCRUAL' as const, days: 1, effectiveOn: '2026-09-01' },
    ];
    expect(projectBalance(entries, '2026-08-31', '2026-08-01').balanceDays).toBe(1);
  });
});
