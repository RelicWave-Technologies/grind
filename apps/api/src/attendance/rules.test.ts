import { describe, expect, it } from 'vitest';
import { minimumsOn, type DayStatus } from '@grind/types';
import { nextMinimumsHistory } from './minimums';
import {
  isLateArrival,
  judgeDay,
  judgeSandwich,
  sandwichSides,
  SANDWICH_MAX_OFF_RUN,
  ruleCode,
  withLateRule,
  type AttendanceDayFacts,
  type AttendanceRulePolicy,
  type SandwichSideDay,
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
    expect(judgeDay(POLICY, facts({ trackedMinutes: 419 }))).toEqual({ tag: 'SHORT_DAY', penaltyDays: 0.5, minMinutes: 420 });
    expect(judgeDay(POLICY, facts({ trackedMinutes: 210 }))).toEqual({ tag: 'SHORT_DAY', penaltyDays: 0.5, minMinutes: 420 });
  });

  it('under 3h30 is a full leave', () => {
    expect(judgeDay(POLICY, facts({ trackedMinutes: 209 }))).toEqual({ tag: 'UNDER_MIN', penaltyDays: 1, minMinutes: 210 });
  });

  it('at the office but nothing tracked is under the minimum, not an absence', () => {
    expect(judgeDay(POLICY, facts({ trackedMinutes: 0, punched: true }))).toEqual({ tag: 'UNDER_MIN', penaltyDays: 1, minMinutes: 210 });
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
      minMinutes: 210,
    });
    expect(judgeDay(POLICY, facts({ status: HALF_PAID, trackedMinutes: 0, punched: false }))).toEqual({
      tag: 'HALF_DAY_SHORT',
      penaltyDays: 0.5,
      minMinutes: 210,
    });
  });

  it('applies to an unpaid half day too', () => {
    expect(judgeDay(POLICY, facts({ status: status('UNPAID_LEAVE', 0.5, 'SECOND_HALF'), trackedMinutes: 60 }))).toEqual({
      tag: 'HALF_DAY_SHORT',
      penaltyDays: 0.5,
      minMinutes: 210,
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
      minMinutes: 420,
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
      minMinutes: 420,
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
  // Lateness is the door punch-in after the shift start + grace, not when
  // tracked work started. Only STANDARD people are judged — remote and exempt
  // people never. First-half leave is late after the afternoon time (14:00),
  // no grace; second-half leave is not checked.
  const shiftStartMs = Date.parse('2026-09-01T03:30:00Z'); // 09:00 IST
  const afternoonMs = Date.parse('2026-09-01T08:30:00Z'); // 14:00 IST
  const at = (minutesAfterStart: number) => shiftStartMs + minutesAfterStart * 60_000;
  const base = { status: WORKING, mode: 'STANDARD' as const, shiftStartMs, graceMinutes: 30, halfDayLateAfterMs: afternoonMs };

  it('is late only past the start plus the grace', () => {
    expect(isLateArrival({ ...base, punchInMs: at(30) })).toBe(false);
    expect(isLateArrival({ ...base, punchInMs: at(31) })).toBe(true);
  });

  it('is never late for an exempt person or without a punch-in', () => {
    expect(isLateArrival({ ...base, mode: 'EXEMPT', punchInMs: at(120) })).toBe(false);
    expect(isLateArrival({ ...base, punchInMs: null })).toBe(false);
  });

  it('on a first-half leave day is late only after 14:00, with no grace', () => {
    expect(isLateArrival({ ...base, status: HALF_PAID, punchInMs: afternoonMs })).toBe(false);
    expect(isLateArrival({ ...base, status: HALF_PAID, punchInMs: afternoonMs + 60_000 })).toBe(true);
    expect(isLateArrival({ ...base, status: status('UNPAID_LEAVE', 0.5, 'FIRST_HALF'), punchInMs: at(6 * 60) })).toBe(true);
    // Hours past the shift start, still before the afternoon: on time.
    expect(isLateArrival({ ...base, status: HALF_PAID, punchInMs: at(240) })).toBe(false);
    expect(isLateArrival({ ...base, status: HALF_PAID, mode: 'EXEMPT', punchInMs: at(6 * 60) })).toBe(false);
  });

  it('never counts a remote person late, nor a second-half leave day', () => {
    expect(isLateArrival({ ...base, mode: 'REMOTE', punchInMs: at(120) })).toBe(false);
    expect(isLateArrival({ ...base, status: HALF_PAID, mode: 'REMOTE', punchInMs: at(6 * 60) })).toBe(false);
    expect(isLateArrival({
      ...base,
      status: status('PAID_LEAVE', 0.5, 'SECOND_HALF'),
      punchInMs: at(120),
    })).toBe(false);
    expect(isLateArrival({
      ...base,
      status: status('UNPAID_LEAVE', 0.5, 'SECOND_HALF'),
      punchInMs: at(6 * 60),
    })).toBe(false);
  });

  it('never counts an approved WFH day late, even with a punch that day', () => {
    expect(isLateArrival({ ...base, punchInMs: at(7 * 60), wfhApproved: true })).toBe(false);
    expect(isLateArrival({ ...base, punchInMs: at(7 * 60), wfhApproved: false })).toBe(true);
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


describe('judgeDay — the 8h / 4h minimums', () => {
  const EIGHT: AttendanceRulePolicy = { ...POLICY, fullDayMinMinutes: 480, halfDayMinMinutes: 240 };

  it('exactly 8h is a full day; a minute less is a half day', () => {
    expect(judgeDay(EIGHT, facts({ trackedMinutes: 480 }))).toBeNull();
    expect(judgeDay(EIGHT, facts({ trackedMinutes: 479 }))).toEqual({ tag: 'SHORT_DAY', penaltyDays: 0.5, minMinutes: 480 });
  });

  it('exactly 4h is a half day; a minute less is a full leave', () => {
    expect(judgeDay(EIGHT, facts({ trackedMinutes: 240 }))).toEqual({ tag: 'SHORT_DAY', penaltyDays: 0.5, minMinutes: 480 });
    expect(judgeDay(EIGHT, facts({ trackedMinutes: 239 }))).toEqual({ tag: 'UNDER_MIN', penaltyDays: 1, minMinutes: 240 });
  });

  it('7h30 was a full day under 7h and is a half day under 8h', () => {
    expect(judgeDay(POLICY, facts({ trackedMinutes: 450 }))).toBeNull();
    expect(judgeDay(EIGHT, facts({ trackedMinutes: 450 }))?.tag).toBe('SHORT_DAY');
  });
});

describe('minimums history — a change never reaches back', () => {
  const OLD = { fullDayMinMinutes: 420, halfDayMinMinutes: 210 };
  const NEW = { fullDayMinMinutes: 480, halfDayMinMinutes: 240 };

  it('keeps the old pair for every date before the change', () => {
    const next = nextMinimumsHistory({ current: OLD, history: [], next: NEW, from: '2026-11-21' });
    expect(next).toEqual({ changed: true, eras: [{ until: '2026-11-21', ...OLD }] });
    const eras = 'eras' in next ? next.eras : [];
    expect(minimumsOn('2026-11-20', NEW, eras)).toEqual(OLD);
    expect(minimumsOn('2026-09-01', NEW, eras)).toEqual(OLD);
    expect(minimumsOn('2026-11-21', NEW, eras)).toEqual(NEW);
    expect(minimumsOn('2027-01-01', NEW, eras)).toEqual(NEW);
  });

  it('saving the same numbers writes nothing', () => {
    expect(nextMinimumsHistory({ current: OLD, history: [], next: OLD, from: '2026-11-21' })).toEqual({ changed: false, eras: [] });
  });

  it('correcting the numbers on the same start date keeps one era', () => {
    const eras = [{ until: '2026-11-21', ...OLD }];
    expect(nextMinimumsHistory({ current: NEW, history: eras, next: { fullDayMinMinutes: 470, halfDayMinMinutes: 240 }, from: '2026-11-21' }))
      .toEqual({ changed: false, eras });
  });

  it('a second change stacks, and cannot start before the first', () => {
    const eras = [{ until: '2026-11-21', ...OLD }];
    const later = nextMinimumsHistory({ current: NEW, history: eras, next: { fullDayMinMinutes: 510, halfDayMinMinutes: 255 }, from: '2027-01-01' });
    expect(later).toEqual({ changed: true, eras: [...eras, { until: '2027-01-01', ...NEW }] });
    expect(minimumsOn('2026-12-15', { fullDayMinMinutes: 510, halfDayMinMinutes: 255 }, 'eras' in later ? later.eras : [])).toEqual(NEW);
    expect(nextMinimumsHistory({ current: NEW, history: eras, next: OLD, from: '2026-11-01' }))
      .toEqual({ error: 'minimums_from_before_last_change' });
  });
});

describe('sandwich rule', () => {
  const OFF = status('WEEKLY_OFF', 0);
  const HOLIDAY = status('HOLIDAY', 0);
  const FULL_PAID = status('PAID_LEAVE', 0);
  const FULL_UNPAID = status('UNPAID_LEAVE', 0);
  const LWA = { tag: 'NO_APPLICATION' as const, penaltyDays: 1 };
  const side = (date: string, over: Partial<SandwichSideDay> = {}) => ({
    date,
    status: WORKING,
    verdict: null,
    override: null,
    ...over,
  });
  // Sat 21 – Sun 22 – Mon 23 November 2026, judged on the 25th.
  const sandwich = (over: Partial<Parameters<typeof judgeSandwich>[0]> = {}) =>
    judgeSandwich({
      date: '2026-11-22',
      today: '2026-11-25',
      rulesFrom: '2026-09-01',
      sandwichFrom: '2026-11-21',
      status: OFF,
      before: side('2026-11-21', { verdict: LWA }),
      after: side('2026-11-23', { verdict: LWA }),
      ...over,
    });

  it('charges the Sunday when both Saturday and Monday were absent', () => {
    expect(sandwich()).toEqual({ tag: 'SANDWICH', penaltyDays: 1 });
  });

  it('charges a holiday between two days away the same way', () => {
    expect(sandwich({ status: HOLIDAY })).toEqual({ tag: 'SANDWICH', penaltyDays: 1 });
  });

  it('never charges a working day, or a day off past the longest run', () => {
    expect(sandwich({ status: WORKING })).toBeNull();
    expect(sandwich({ before: null })).toBeNull();
    expect(sandwich({ after: null })).toBeNull();
  });

  it('counts approved full-day leave, paid or unpaid, as away', () => {
    expect(sandwich({ before: side('2026-11-21', { status: FULL_PAID }), after: side('2026-11-23', { status: FULL_UNPAID }) }))
      .toEqual({ tag: 'SANDWICH', penaltyDays: 1 });
    // Half-day leave whose working half fell short is a whole day away too.
    expect(sandwich({ after: side('2026-11-23', { status: HALF_PAID, verdict: { tag: 'HALF_DAY_SHORT', penaltyDays: 0.5 } }) }))
      .toEqual({ tag: 'SANDWICH', penaltyDays: 1 });
  });

  it('counts a day under the half-day minimum as away', () => {
    expect(sandwich({ after: side('2026-11-23', { verdict: { tag: 'UNDER_MIN', penaltyDays: 1 } }) }))
      .toEqual({ tag: 'SANDWICH', penaltyDays: 1 });
  });

  it('does not charge when either side was worked, even as a half day', () => {
    expect(sandwich({ after: side('2026-11-23') })).toBeNull();
    expect(sandwich({ before: side('2026-11-21', { verdict: { tag: 'SHORT_DAY', penaltyDays: 0.5 } }) })).toBeNull();
    expect(sandwich({ before: side('2026-11-21', { status: HALF_PAID }) })).toBeNull();
  });

  it('does not charge when a side has no shift', () => {
    expect(sandwich({ before: side('2026-11-21', { status: status('NO_SHIFT', 0), verdict: LWA }) })).toBeNull();
  });

  it('follows a manager correction on either side', () => {
    expect(sandwich({ after: side('2026-11-23', { verdict: LWA, override: 'P' }) })).toBeNull();
    expect(sandwich({ after: side('2026-11-23', { override: 'FULL_LEAVE' }) })).toEqual({ tag: 'SANDWICH', penaltyDays: 1 });
    expect(sandwich({ after: side('2026-11-23', { override: 'HALF_LEAVE' }) })).toBeNull();
  });

  it('waits until the working day after the run is over', () => {
    expect(sandwich({ today: '2026-11-23' })).toBeNull();
    expect(sandwich({ today: '2026-11-24' })).toEqual({ tag: 'SANDWICH', penaltyDays: 1 });
  });

  it('is off without a start date, and never reaches a run whose day before is earlier', () => {
    expect(sandwich({ sandwichFrom: null })).toBeNull();
    expect(sandwich({ sandwichFrom: '2026-11-22' })).toBeNull();
    expect(sandwich({ rulesFrom: null })).toBeNull();
  });

  it('never charges an exempt person', () => {
    expect(sandwich({ mode: 'EXEMPT' })).toBeNull();
    expect(sandwich({ mode: 'REMOTE' })).toEqual({ tag: 'SANDWICH', penaltyDays: 1 });
  });

  describe('finding the working days either side', () => {
    // 2026-11: Fri 20, Sat 21, Sun 22, Mon 23, Tue 24.
    const calendar = (off: string[]) => (day: string) => (off.includes(day) ? OFF : WORKING);

    it('a single Sunday off: Saturday and Monday', () => {
      expect(sandwichSides('2026-11-22', calendar(['2026-11-22']))).toEqual({ before: '2026-11-21', after: '2026-11-23' });
    });

    it('a Saturday and Sunday off: Friday and Monday, from either day', () => {
      const cal = calendar(['2026-11-21', '2026-11-22']);
      expect(sandwichSides('2026-11-21', cal)).toEqual({ before: '2026-11-20', after: '2026-11-23' });
      expect(sandwichSides('2026-11-22', cal)).toEqual({ before: '2026-11-20', after: '2026-11-23' });
    });

    it('a holiday next to a weekly off joins the run', () => {
      const cal = (day: string) => (day === '2026-11-23' ? HOLIDAY : day === '2026-11-22' ? OFF : WORKING);
      expect(sandwichSides('2026-11-23', cal)).toEqual({ before: '2026-11-21', after: '2026-11-24' });
    });

    it('a weekday week off, any day of the week', () => {
      expect(sandwichSides('2026-11-24', calendar(['2026-11-24']))).toEqual({ before: '2026-11-23', after: '2026-11-25' });
    });

    it(`gives up on a run longer than ${SANDWICH_MAX_OFF_RUN} days`, () => {
      const run = (n: number) => Array.from({ length: n }, (_, i) => `2026-12-${String(i + 1).padStart(2, '0')}`);
      expect(sandwichSides('2026-12-01', calendar(run(SANDWICH_MAX_OFF_RUN)))).toEqual({
        before: '2026-11-30',
        after: `2026-12-${String(SANDWICH_MAX_OFF_RUN + 1).padStart(2, '0')}`,
      });
      expect(sandwichSides('2026-12-01', calendar(run(SANDWICH_MAX_OFF_RUN + 1)))).toBeNull();
      expect(sandwichSides('2026-12-05', calendar(run(SANDWICH_MAX_OFF_RUN + 1)))).toBeNull();
    });
  });

  it('costs a full day of leave on the sheet: paid while the balance lasts', () => {
    expect(ruleCode(OFF, { tag: 'SANDWICH', penaltyDays: 1 }, undefined)).toBe('PL');
    expect(ruleCode(OFF, { tag: 'SANDWICH', penaltyDays: 1 }, 0)).toBe('LWP');
    expect(ruleCode(HOLIDAY, { tag: 'SANDWICH', penaltyDays: 1 }, undefined)).toBe('PL');
  });
});
