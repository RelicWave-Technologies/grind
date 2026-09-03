import { describe, it, expect } from 'vitest';
import { NINE_TO_SIX, type ShiftSchedule } from '@grind/types';
import {
  WorkingCalendar,
  leaveDateRange,
  addIsoDays,
  weekdayForDate,
  isLastSaturdayOfMonth,
} from './workingCalendar';

const TZ = 'Asia/Kolkata';
const U = 'user-1';

/** Mon-Fri 09:00-18:00, assigned from well before any date used here. */
function assignment(schedule: ShiftSchedule = NINE_TO_SIX, name = 'Day Shift') {
  return [
    {
      shiftId: 'shift-1',
      effectiveFrom: new Date('2020-01-01T00:00:00Z'),
      effectiveTo: null,
      shiftNameSnapshot: name,
      scheduleSnapshot: schedule,
    },
  ];
}

function cal(over: Partial<ConstructorParameters<typeof WorkingCalendar>[0]> = {}) {
  return new WorkingCalendar({
    tz: TZ,
    shiftAssignments: { [U]: assignment() },
    userTeamIds: { [U]: null },
    ...over,
  });
}

// 2026-08-17 is a Monday; 2026-08-22 Saturday; 2026-08-23 Sunday.
describe('WorkingCalendar — the shape of an ordinary week', () => {
  it('a working weekday is WORKING and expects a full day', () => {
    const s = cal().dayStatus(U, '2026-08-17');
    expect(s.kind).toBe('WORKING');
    expect(s.expectedFraction).toBe(1);
    expect(s.chargedDays).toBe(0);
    expect(s.shiftName).toBe('Day Shift');
  });

  it('a weekend is WEEKLY_OFF and expects nothing', () => {
    expect(cal().dayStatus(U, '2026-08-22').kind).toBe('WEEKLY_OFF');
    expect(cal().dayStatus(U, '2026-08-23').expectedFraction).toBe(0);
  });

  it('a user with no shift assignment is NO_SHIFT, not WORKING', () => {
    const c = new WorkingCalendar({ tz: TZ });
    expect(c.dayStatus(U, '2026-08-17').kind).toBe('NO_SHIFT');
  });
});

describe('WorkingCalendar — 0.0 is the value doing the real work', () => {
  it('a company holiday is paid and costs nobody any balance', () => {
    const c = cal({ holidays: [{ date: '2026-08-19', name: 'Independence Day', teamId: null }] });
    const s = c.dayStatus(U, '2026-08-19');
    expect(s.kind).toBe('HOLIDAY');
    expect(s.paid).toBe(true);
    expect(s.chargedDays).toBe(0);
    expect(s.label).toBe('Independence Day');
  });

  it('a weekly off costs 0 even though nobody is paid for it', () => {
    const s = cal().dayStatus(U, '2026-08-22');
    expect(s.chargedDays).toBe(0);
    expect(s.paid).toBe(false);
  });

  it('unpaid leave costs 0 balance because it costs no money', () => {
    const c = cal({
      approvedLeave: [
        { userId: U, startDate: '2026-08-17', endDate: '2026-08-17', portion: 'FULL', kind: 'UNPAID', label: 'LWP' },
      ],
    });
    const s = c.dayStatus(U, '2026-08-17');
    expect(s.kind).toBe('UNPAID_LEAVE');
    expect(s.paid).toBe(false);
    expect(s.chargedDays).toBe(0);
  });

  it('a team holiday does not apply to someone on another team', () => {
    const c = new WorkingCalendar({
      tz: TZ,
      shiftAssignments: { [U]: assignment(), other: assignment() },
      userTeamIds: { [U]: 'team-a', other: 'team-b' },
      holidays: [{ date: '2026-08-19', name: 'Team A offsite', teamId: 'team-a' }],
    });
    expect(c.dayStatus(U, '2026-08-19').kind).toBe('HOLIDAY');
    expect(c.dayStatus('other', '2026-08-19').kind).toBe('WORKING');
  });
});

describe('WorkingCalendar — precedence', () => {
  it('a holiday outranks leave, so the leave is free that day', () => {
    const c = cal({
      holidays: [{ date: '2026-08-19', name: 'Holi', teamId: null }],
      approvedLeave: [
        { userId: U, startDate: '2026-08-17', endDate: '2026-08-21', portion: 'FULL', kind: 'PAID', label: 'Casual' },
      ],
    });
    expect(c.dayStatus(U, '2026-08-19').kind).toBe('HOLIDAY');
    expect(c.dayStatus(U, '2026-08-19').chargedDays).toBe(0);
    expect(c.dayStatus(U, '2026-08-18').kind).toBe('PAID_LEAVE');
  });

  it('a weekly off outranks leave', () => {
    const c = cal({
      approvedLeave: [
        { userId: U, startDate: '2026-08-21', endDate: '2026-08-24', portion: 'FULL', kind: 'PAID', label: null },
      ],
    });
    expect(c.dayStatus(U, '2026-08-22').kind).toBe('WEEKLY_OFF');
    expect(c.dayStatus(U, '2026-08-23').kind).toBe('WEEKLY_OFF');
    expect(c.dayStatus(U, '2026-08-24').kind).toBe('PAID_LEAVE');
  });
});

describe('WorkingCalendar — halves', () => {
  it('a first-half absence still expects half a day of work', () => {
    const c = cal({
      approvedLeave: [
        { userId: U, startDate: '2026-08-17', endDate: '2026-08-17', portion: 'FIRST_HALF', kind: 'PAID', label: 'Half Day' },
      ],
    });
    const s = c.dayStatus(U, '2026-08-17');
    expect(s.portion).toBe('FIRST_HALF');
    expect(s.chargedDays).toBe(0.5);
    expect(s.expectedFraction).toBe(0.5);
  });

  it('second half is distinguishable from first half', () => {
    const c = cal({
      approvedLeave: [
        { userId: U, startDate: '2026-08-17', endDate: '2026-08-17', portion: 'SECOND_HALF', kind: 'PAID', label: null },
      ],
    });
    expect(c.dayStatus(U, '2026-08-17').portion).toBe('SECOND_HALF');
  });
});

describe('WorkingCalendar.quote — the Mar 10-12 row', () => {
  it('three requested days containing a holiday charge 2, not 3', () => {
    const c = cal({ holidays: [{ date: '2026-08-19', name: 'Holi', teamId: null }] });
    const q = c.quote({ userId: U, dates: leaveDateRange('2026-08-18', '2026-08-20'), portion: 'FULL', kind: 'PAID' });
    expect(q.chargedDays).toBe(2);
    expect(q.days.map((d) => d.kind)).toEqual(['PAID_LEAVE', 'HOLIDAY', 'PAID_LEAVE']);
  });

  it('a Mon-Fri request spanning a weekend charges only the working days', () => {
    const c = cal();
    const q = c.quote({ userId: U, dates: leaveDateRange('2026-08-21', '2026-08-24'), portion: 'FULL', kind: 'PAID' });
    // Fri + Mon are working; Sat + Sun are not.
    expect(q.chargedDays).toBe(2);
  });

  it('a half day quotes 0.5', () => {
    const q = cal().quote({ userId: U, dates: ['2026-08-17'], portion: 'FIRST_HALF', kind: 'PAID' });
    expect(q.chargedDays).toBe(0.5);
  });

  it('an unpaid request quotes 0 however long it is', () => {
    const q = cal().quote({ userId: U, dates: leaveDateRange('2026-08-17', '2026-08-21'), portion: 'FULL', kind: 'UNPAID' });
    expect(q.chargedDays).toBe(0);
  });

  it('halves accumulate exactly — five half days are 2.5, not 2.4999', () => {
    const c = cal();
    let total = 0;
    for (const d of leaveDateRange('2026-08-17', '2026-08-21')) {
      total += c.quote({ userId: U, dates: [d], portion: 'FIRST_HALF', kind: 'PAID' }).chargedDays;
    }
    expect(total).toBe(2.5);
  });

  it('quoting a range with no shift charges nothing', () => {
    const c = new WorkingCalendar({ tz: TZ });
    const q = c.quote({ userId: U, dates: leaveDateRange('2026-08-17', '2026-08-21'), portion: 'FULL', kind: 'PAID' });
    expect(q.chargedDays).toBe(0);
  });
});

describe('date helpers', () => {
  it('leaveDateRange is inclusive', () => {
    expect(leaveDateRange('2026-08-17', '2026-08-19')).toEqual(['2026-08-17', '2026-08-18', '2026-08-19']);
  });

  it('leaveDateRange returns a single day for an equal range', () => {
    expect(leaveDateRange('2026-08-17', '2026-08-17')).toEqual(['2026-08-17']);
  });

  it('leaveDateRange returns nothing when to precedes from', () => {
    expect(leaveDateRange('2026-08-19', '2026-08-17')).toEqual([]);
  });

  it('addIsoDays crosses a month boundary', () => {
    expect(addIsoDays('2026-08-31', 1)).toBe('2026-09-01');
  });

  it('weekdayForDate agrees with the calendar', () => {
    expect(weekdayForDate('2026-08-17')).toBe('mon');
    expect(weekdayForDate('2026-08-22')).toBe('sat');
  });
});


/** Mon-Sat, the six-day week both companies here actually work. */
const SIX_DAY: ShiftSchedule = {
  mon: { start: '09:00', end: '18:00' },
  tue: { start: '09:00', end: '18:00' },
  wed: { start: '09:00', end: '18:00' },
  thu: { start: '09:00', end: '18:00' },
  fri: { start: '09:00', end: '18:00' },
  sat: { start: '09:00', end: '18:00' },
  sun: null,
};

describe('isLastSaturdayOfMonth', () => {
  it('knows the last Saturday of August 2026', () => {
    // Saturdays: 1, 8, 15, 22, 29. August has 31 days.
    expect(isLastSaturdayOfMonth('2026-08-29')).toBe(true);
    expect(isLastSaturdayOfMonth('2026-08-22')).toBe(false);
    expect(isLastSaturdayOfMonth('2026-08-01')).toBe(false);
  });

  it('is false for every day that is not a Saturday', () => {
    expect(isLastSaturdayOfMonth('2026-08-28')).toBe(false); // Friday
    expect(isLastSaturdayOfMonth('2026-08-30')).toBe(false); // Sunday
  });

  it('handles a month whose last day IS a Saturday', () => {
    // 2026-10-31 is a Saturday and the last day of October.
    expect(weekdayForDate('2026-10-31')).toBe('sat');
    expect(isLastSaturdayOfMonth('2026-10-31')).toBe(true);
    expect(isLastSaturdayOfMonth('2026-10-24')).toBe(false);
  });

  it('handles February in a leap year', () => {
    // 2028 is a leap year; 2028-02-26 is the last Saturday.
    expect(isLastSaturdayOfMonth('2028-02-26')).toBe(true);
    expect(isLastSaturdayOfMonth('2028-02-19')).toBe(false);
  });
});

describe('WorkingCalendar — the last Saturday is not a working day', () => {
  function sixDayCal(lastSaturdayOff: boolean) {
    return new WorkingCalendar({
      tz: TZ,
      lastSaturdayOffFor: { [U]: lastSaturdayOff },
      shiftAssignments: { [U]: assignment(SIX_DAY) },
      userTeamIds: { [U]: null },
    });
  }

  it('an ordinary Saturday is still a working day on a six-day week', () => {
    expect(sixDayCal(true).dayStatus(U, '2026-08-22').kind).toBe('WORKING');
  });

  it('the last Saturday reads as a weekly off', () => {
    expect(sixDayCal(true).dayStatus(U, '2026-08-29').kind).toBe('WEEKLY_OFF');
  });

  it('stays a working day when the rule is off', () => {
    expect(sixDayCal(false).dayStatus(U, '2026-08-29').kind).toBe('WORKING');
  });

  it('costs nobody any balance, like every other non-working day', () => {
    const q = sixDayCal(true).quote({
      userId: U, dates: ['2026-08-29'], portion: 'FULL', kind: 'PAID',
    });
    expect(q.chargedDays).toBe(0);
  });

  it('a week of leave containing it charges one day less', () => {
    // Mon 24 -> Sat 29 is six working days on this shift, minus the last Saturday.
    const q = sixDayCal(true).quote({
      userId: U, dates: leaveDateRange('2026-08-24', '2026-08-29'), portion: 'FULL', kind: 'PAID',
    });
    expect(q.chargedDays).toBe(5);
  });

  it('cannot invent a day off for somebody already not working Saturdays', () => {
    // NINE_TO_SIX has sat: null, so the rule has nothing to turn off.
    const c = new WorkingCalendar({
      tz: TZ, lastSaturdayOffFor: { [U]: true },
      shiftAssignments: { [U]: assignment() },
      userTeamIds: { [U]: null },
    });
    expect(c.dayStatus(U, '2026-08-29').kind).toBe('WEEKLY_OFF');
  });
});


describe('WorkingCalendar — the last Saturday is per person, not per workspace', () => {
  it('only takes it off for the people it applies to', () => {
    const EMIAC = 'emiac-1';
    const MACOBS = 'macobs-1';
    const c = new WorkingCalendar({
      tz: TZ,
      // Two employers share this workspace; only one takes the Saturday off.
      lastSaturdayOffFor: { [EMIAC]: true, [MACOBS]: false },
      shiftAssignments: { [EMIAC]: assignment(SIX_DAY), [MACOBS]: assignment(SIX_DAY) },
      userTeamIds: { [EMIAC]: null, [MACOBS]: null },
    });

    expect(c.dayStatus(EMIAC, '2026-08-29').kind).toBe('WEEKLY_OFF');
    expect(c.dayStatus(MACOBS, '2026-08-29').kind).toBe('WORKING');
  });

  it('charges the same week differently for the two of them', () => {
    const EMIAC = 'emiac-1';
    const MACOBS = 'macobs-1';
    const c = new WorkingCalendar({
      tz: TZ,
      lastSaturdayOffFor: { [EMIAC]: true, [MACOBS]: false },
      shiftAssignments: { [EMIAC]: assignment(SIX_DAY), [MACOBS]: assignment(SIX_DAY) },
      userTeamIds: { [EMIAC]: null, [MACOBS]: null },
    });
    const dates = leaveDateRange('2026-08-24', '2026-08-29');

    expect(c.quote({ userId: EMIAC, dates, portion: 'FULL', kind: 'PAID' }).chargedDays).toBe(5);
    expect(c.quote({ userId: MACOBS, dates, portion: 'FULL', kind: 'PAID' }).chargedDays).toBe(6);
  });
});

describe('WorkingCalendar — paid leave is only paid while a balance covers it', () => {
  const leave = [
    { userId: U, startDate: '2026-08-17', endDate: '2026-08-18', portion: 'FULL' as const, kind: 'PAID' as const, label: 'Paid leave' },
  ];

  it('a covered day stays PAID_LEAVE', () => {
    const s = cal({ approvedLeave: leave }).dayStatus(U, '2026-08-17');
    expect(s.kind).toBe('PAID_LEAVE');
    expect(s.paid).toBe(true);
    expect(s.chargedDays).toBe(1);
  });

  it('an uncovered day is UNPAID_LEAVE, and only that day', () => {
    const c = cal({
      approvedLeave: leave,
      unfundedLeaveDays: new Map([[U, new Set(['2026-08-18'])]]),
    });
    expect(c.dayStatus(U, '2026-08-17').kind).toBe('PAID_LEAVE');

    const s = c.dayStatus(U, '2026-08-18');
    expect(s.kind).toBe('UNPAID_LEAVE');
    expect(s.paid).toBe(false);
    expect(s.chargedDays).toBe(0);
  });

  it('still expects no work on the uncovered day — unpaid is not absent', () => {
    const c = cal({
      approvedLeave: leave,
      unfundedLeaveDays: new Map([[U, new Set(['2026-08-18'])]]),
    });
    expect(c.dayStatus(U, '2026-08-18').expectedFraction).toBe(0);
  });

  it('never turns a weekly off into unpaid leave', () => {
    // 2026-08-22 is a Saturday. Precedence puts the weekly off first, and a
    // funding miss must not be able to reach past it.
    const c = cal({
      approvedLeave: [{ ...leave[0]!, startDate: '2026-08-22', endDate: '2026-08-22' }],
      unfundedLeaveDays: new Map([[U, new Set(['2026-08-22'])]]),
    });
    expect(c.dayStatus(U, '2026-08-22').kind).toBe('WEEKLY_OFF');
  });

  it('leaves another person alone', () => {
    const c = cal({
      approvedLeave: leave,
      unfundedLeaveDays: new Map([['someone-else', new Set(['2026-08-17'])]]),
    });
    expect(c.dayStatus(U, '2026-08-17').kind).toBe('PAID_LEAVE');
  });
});
