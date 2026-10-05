import { describe, expect, it } from 'vitest';
import type { DayStatus } from '@grind/types';
import {
  isLateArrival,
  judgeDay,
  ruleCode,
  withLateRule,
  type AttendanceDayFacts,
  type AttendanceRulePolicy,
} from './rules';

const POLICY: AttendanceRulePolicy = {
  from: '2026-09-01',
  fullDayMinMinutes: 420,
  halfDayMinMinutes: 210,
  wfhRequiresApproval: true,
};

function status(kind: DayStatus['kind'], expectedFraction: number, portion: DayStatus['portion'] = null): DayStatus {
  return {
    date: '2026-09-10',
    kind,
    portion,
    paid: kind === 'PAID_LEAVE' || kind === 'HOLIDAY',
    chargedDays: kind === 'PAID_LEAVE' ? 1 - expectedFraction : 0,
    expectedFraction,
    shiftName: 'Day',
    label: null,
  };
}

const WORKING = status('WORKING', 1);
const HALF_PAID = status('PAID_LEAVE', 0.5, 'FIRST_HALF');

/** An office day with a punch, judged the day after. */
function facts(over: Partial<AttendanceDayFacts>): AttendanceDayFacts {
  return {
    date: '2026-09-10',
    today: '2026-10-03',
    status: WORKING,
    trackedMinutes: 480,
    punched: true,
    punchCoverage: true,
    wfhApproved: false,
    leaveApplied: false,
    ...over,
  };
}

describe('judgeDay — full working day', () => {
  it('7h or more is a full day', () => {
    expect(judgeDay(POLICY, facts({ trackedMinutes: 420 }))).toBeNull();
    expect(judgeDay(POLICY, facts({ trackedMinutes: 600 }))).toBeNull();
  });

  it('3h30 up to 7h is a half day', () => {
    expect(judgeDay(POLICY, facts({ trackedMinutes: 419 }))).toEqual({ tag: 'SHORT_DAY', penaltyDays: 0.5 });
    expect(judgeDay(POLICY, facts({ trackedMinutes: 210 }))).toEqual({ tag: 'SHORT_DAY', penaltyDays: 0.5 });
  });

  it('under 3h30 is a full leave', () => {
    expect(judgeDay(POLICY, facts({ trackedMinutes: 209 }))).toEqual({ tag: 'UNDER_MIN', penaltyDays: 1 });
  });

  it('at the office but nothing tracked is under the minimum, not an absence', () => {
    expect(judgeDay(POLICY, facts({ trackedMinutes: 0, punched: true }))).toEqual({ tag: 'UNDER_MIN', penaltyDays: 1 });
  });
});

describe('judgeDay — half-day leave', () => {
  it('3h30 on the working half is enough', () => {
    expect(judgeDay(POLICY, facts({ status: HALF_PAID, trackedMinutes: 210 }))).toBeNull();
  });

  it('less turns the half day into a full leave', () => {
    expect(judgeDay(POLICY, facts({ status: HALF_PAID, trackedMinutes: 120 }))).toEqual({
      tag: 'HALF_DAY_SHORT',
      penaltyDays: 0.5,
    });
    expect(judgeDay(POLICY, facts({ status: HALF_PAID, trackedMinutes: 0, punched: false }))).toEqual({
      tag: 'HALF_DAY_SHORT',
      penaltyDays: 0.5,
    });
  });

  it('applies to an unpaid half day too', () => {
    expect(judgeDay(POLICY, facts({ status: status('UNPAID_LEAVE', 0.5, 'SECOND_HALF'), trackedMinutes: 60 }))).toEqual({
      tag: 'HALF_DAY_SHORT',
      penaltyDays: 0.5,
    });
  });
});

describe('judgeDay — absence', () => {
  it('nothing tracked, no punch and no application is leave without approval', () => {
    expect(judgeDay(POLICY, facts({ trackedMinutes: 0, punched: false }))).toEqual({
      tag: 'NO_APPLICATION',
      penaltyDays: 1,
    });
  });

  it('a pending or rejected application is still without approval, but says so', () => {
    expect(judgeDay(POLICY, facts({ trackedMinutes: 0, punched: false, leaveApplied: true }))).toEqual({
      tag: 'LEAVE_NOT_APPROVED',
      penaltyDays: 1,
    });
  });

  it('is judged even on a date the punch import missed', () => {
    expect(judgeDay(POLICY, facts({ trackedMinutes: 0, punched: false, punchCoverage: false }))).toEqual({
      tag: 'NO_APPLICATION',
      penaltyDays: 1,
    });
  });
});

describe('judgeDay — work from home', () => {
  it('tracked time with no punch and no approval is leave, however long', () => {
    expect(judgeDay(POLICY, facts({ trackedMinutes: 540, punched: false }))).toEqual({
      tag: 'WFH_UNAPPROVED',
      penaltyDays: 1,
    });
  });

  it('with an approved request it is an office day, hour rules included', () => {
    expect(judgeDay(POLICY, facts({ trackedMinutes: 540, punched: false, wfhApproved: true }))).toBeNull();
    expect(judgeDay(POLICY, facts({ trackedMinutes: 300, punched: false, wfhApproved: true }))).toEqual({
      tag: 'SHORT_DAY',
      penaltyDays: 0.5,
    });
  });

  it('never fires on a date the punch import does not cover', () => {
    expect(judgeDay(POLICY, facts({ trackedMinutes: 540, punched: false, punchCoverage: false }))).toBeNull();
  });

  it('can be switched off', () => {
    expect(judgeDay({ ...POLICY, wfhRequiresApproval: false }, facts({ trackedMinutes: 540, punched: false }))).toBeNull();
  });
});

describe('judgeDay — per-person mode', () => {
  it('REMOTE skips the work-from-home rule but keeps the hours', () => {
    expect(judgeDay(POLICY, facts({ trackedMinutes: 540, punched: false, mode: 'REMOTE' }))).toBeNull();
    expect(judgeDay(POLICY, facts({ trackedMinutes: 300, punched: false, mode: 'REMOTE' }))).toEqual({
      tag: 'SHORT_DAY',
      penaltyDays: 0.5,
    });
    expect(judgeDay(POLICY, facts({ trackedMinutes: 0, punched: false, mode: 'REMOTE' }))).toEqual({
      tag: 'NO_APPLICATION',
      penaltyDays: 1,
    });
  });

  it('EXEMPT is outside the rules entirely', () => {
    expect(judgeDay(POLICY, facts({ trackedMinutes: 0, punched: false, mode: 'EXEMPT' }))).toBeNull();
    expect(judgeDay(POLICY, facts({ trackedMinutes: 60, mode: 'EXEMPT' }))).toBeNull();
  });
});

describe('judgeDay — days it leaves alone', () => {
  it('before the rules start, today and the future', () => {
    expect(judgeDay(POLICY, facts({ date: '2026-08-31', trackedMinutes: 0, punched: false }))).toBeNull();
    expect(judgeDay(POLICY, facts({ date: '2026-10-03', today: '2026-10-03', trackedMinutes: 0, punched: false }))).toBeNull();
    expect(judgeDay(POLICY, facts({ date: '2026-10-05', today: '2026-10-03', trackedMinutes: 0, punched: false }))).toBeNull();
  });

  it('when the rules are off', () => {
    expect(judgeDay({ ...POLICY, from: null }, facts({ trackedMinutes: 0, punched: false }))).toBeNull();
  });

  it('holidays, weekly offs, full leave and days with no shift', () => {
    for (const s of [status('HOLIDAY', 0), status('WEEKLY_OFF', 0), status('PAID_LEAVE', 0, 'FULL'), status('NO_SHIFT', 0)]) {
      expect(judgeDay(POLICY, facts({ status: s, trackedMinutes: 0, punched: false }))).toBeNull();
    }
    expect(judgeDay(POLICY, facts({ status: null, trackedMinutes: 0, punched: false }))).toBeNull();
  });
});

describe('ruleCode — paid as far as the balance reaches', () => {
  it('a short day is half a day of leave', () => {
    const v = { tag: 'SHORT_DAY' as const, penaltyDays: 0.5 };
    expect(ruleCode(WORKING, v, undefined)).toBe('PL_HD');
    expect(ruleCode(WORKING, v, 0)).toBe('LWP_HD');
  });

  it('a full-leave verdict is PL, split or LWP by the balance', () => {
    const v = { tag: 'NO_APPLICATION' as const, penaltyDays: 1 };
    expect(ruleCode(WORKING, v, undefined)).toBe('PL');
    expect(ruleCode(WORKING, v, 0.5)).toBe('PL_HD/LWP_HD');
    expect(ruleCode(WORKING, v, 0)).toBe('LWP');
  });

  it('a half-day leave that fell short becomes a whole day', () => {
    const v = { tag: 'HALF_DAY_SHORT' as const, penaltyDays: 0.5 };
    expect(ruleCode(HALF_PAID, v, undefined)).toBe('PL');
    expect(ruleCode(HALF_PAID, v, 0.5)).toBe('PL_HD/LWP_HD');
    expect(ruleCode(HALF_PAID, v, 0)).toBe('LWP');
    // Unpaid half approved, the rule's half paid from the balance.
    expect(ruleCode(status('UNPAID_LEAVE', 0.5, 'FIRST_HALF'), v, undefined)).toBe('PL_HD/LWP_HD');
  });
});

describe('late arrivals', () => {
  // Rule change (time module): lateness is the first TRACKED activity after
  // the shift start + grace, no longer the punch-in. Remote people are judged
  // by their tracked time too; exempt people never; first-half leave never,
  // second-half leave still expects the shift start.
  const shiftStartMs = Date.parse('2026-09-01T03:30:00Z'); // 09:00 IST
  const at = (minutesAfterStart: number) => shiftStartMs + minutesAfterStart * 60_000;
  const base = { status: WORKING, mode: 'STANDARD' as const, shiftStartMs, graceMinutes: 30 };

  it('is late only past the start plus the grace', () => {
    expect(isLateArrival({ ...base, firstTrackedMs: at(30) })).toBe(false);
    expect(isLateArrival({ ...base, firstTrackedMs: at(31) })).toBe(true);
  });

  it('is never late for an exempt person, without tracked time, or on first-half leave', () => {
    expect(isLateArrival({ ...base, mode: 'EXEMPT', firstTrackedMs: at(120) })).toBe(false);
    expect(isLateArrival({ ...base, firstTrackedMs: null })).toBe(false);
    expect(isLateArrival({ ...base, status: HALF_PAID, firstTrackedMs: at(300) })).toBe(false);
  });

  it('judges a remote person by tracked time, and second-half leave by the shift start', () => {
    expect(isLateArrival({ ...base, mode: 'REMOTE', firstTrackedMs: at(120) })).toBe(true);
    expect(isLateArrival({
      ...base,
      status: status('PAID_LEAVE', 0.5, 'SECOND_HALF'),
      firstTrackedMs: at(120),
    })).toBe(true);
  });

  it('charges half a day from the first one past the allowance', () => {
    expect(withLateRule(null, 4, 4)).toBeNull();
    expect(withLateRule(null, 5, 4)).toEqual({ tag: 'LATE', penaltyDays: 0.5 });
    expect(withLateRule(null, null, 4)).toBeNull();
  });

  it('takes one cut a day: another rule\'s verdict stands alone', () => {
    const short = { tag: 'SHORT_DAY' as const, penaltyDays: 0.5 };
    expect(withLateRule(short, 7, 4)).toBe(short);
  });
});
