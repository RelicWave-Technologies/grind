import { EMPTY_SCHEDULE, NINE_TO_SIX, instantForZonedDateTime, zonedDateTimeParts, type ShiftSchedule } from '@grind/types';
import {
  ackToday,
  expire,
  INITIAL_STATE,
  resolveShiftWindow,
  snooze,
  tickShiftMonitor,
  type ShiftAction,
  type ShiftMonitorState,
} from '../../../legacy/agent/src/main/services/shift/decide';
import {
  UNTRACKED_INITIAL_STATE,
  acceptUntrackedNudge,
  snoozeUntrackedNudge,
  tickUntrackedNudge,
  type UntrackedNudgeState,
  type UntrackedTickInput,
} from '../../../legacy/agent/src/main/services/shift/untracked';
import type { Rng } from '../prng';
import type { FnSpec } from '../fixture';
import { DENSE_ZONES, MS_PER_DAY, denseTransitions } from './tzZones';

/**
 * Golden output for the shift reducers: `shift/decide.ts` (the clock-in popup and
 * the shift window) and `shift/untracked.ts` (the "Are you working?" nudge).
 * Both are pure; the zone maths underneath is `packages/types/src/timezone.ts`,
 * covered by `gen/tz.ts`.
 */

const MIN = 60_000;
const pad2 = (n: number): string => String(n).padStart(2, '0');
const hhmm = (h: number, m: number): string => `${pad2(h)}:${pad2(m)}`;
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

/** Zones the reducers are exercised in: DST both ways, midnight changes, 30/45-minute offsets, none. */
const SHIFT_ZONES: readonly string[] = [
  'Asia/Kolkata', 'UTC', 'America/New_York', 'Europe/London', 'Europe/Dublin', 'Australia/Lord_Howe', 'Pacific/Chatham', 'America/Sao_Paulo',
  'America/Havana', 'Asia/Kathmandu', 'Pacific/Apia', 'Africa/Casablanca', 'Antarctica/Troll', 'Asia/Tehran', 'America/Santiago', 'Europe/Paris', 'Asia/Tokyo',
  'America/St_Johns', 'Etc/GMT+5', '+05:30',
];
const BAD_ZONES: readonly string[] = ['', 'Mars/Olympus', 'UTC ', 'Z', 'Etc/GMT+13'];

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

/** Shapes the wire schema would reject; the reducer reads them with `parseInt` anyway. */
const ODD_TIMES: readonly string[] = ['9:00', '09', '09:00:30', 'ab:cd', '', ':', ':30', '-1:00', ' 9:5', '24:00', '23:60', '0x10:00', '1e1:00', '09:00 ', '+9:00', '9.5:00', '００:００', '٠٩:٠٠', '99999999999999999999:00', '-0:00'];

function validTime(rng: Rng): string {
  return rng.weighted<() => string>([
    [() => hhmm(rng.int(0, 23), rng.int(0, 59)), 50],
    [() => hhmm(rng.pick([0, 1, 2, 3, 9, 12, 22, 23]), rng.pick([0, 30, 59])), 40],
    [() => hhmm(rng.int(0, 23), 0), 10],
  ])();
}

function dayEntry(rng: Rng): ShiftSchedule['mon'] {
  if (rng.chance(0.28)) return null;
  if (rng.chance(0.06)) return { start: rng.pick(ODD_TIMES), end: rng.pick([...ODD_TIMES, '18:00']) };
  const startMin = rng.int(0, 23 * 60 + 58);
  const start = hhmm(Math.floor(startMin / 60), startMin % 60);
  if (rng.chance(0.08)) return { start, end: rng.chance(0.5) ? start : validTime(rng) };
  const endMin = Math.min(23 * 60 + 59, startMin + rng.int(1, 12 * 60));
  return { start, end: hhmm(Math.floor(endMin / 60), endMin % 60) };
}

function everyDay(start: string, end: string): ShiftSchedule {
  const day = { start, end };
  return { mon: day, tue: day, wed: day, thu: day, fri: day, sat: day, sun: day };
}

function randomSchedule(rng: Rng): ShiftSchedule {
  return rng.weighted<() => ShiftSchedule>([
    [() => NINE_TO_SIX, 14],
    [() => EMPTY_SCHEDULE, 4],
    [() => everyDay('00:00', '08:00'), 5],
    [() => everyDay('02:30', '10:00'), 5],
    [() => everyDay('01:30', '09:30'), 4],
    [() => everyDay(rng.pick(['00:00', '01:00', '02:00', '03:00']), rng.pick(['06:00', '12:00', '23:59'])), 6],
    [() => Object.fromEntries(WEEKDAY_KEYS.map((k) => [k, dayEntry(rng)])) as ShiftSchedule, 62],
  ])();
}

// ---------------------------------------------------------------------------
// Times
// ---------------------------------------------------------------------------

let transitionsByZone: Map<string, number[]> | null = null;
function transitionsOf(zone: string): number[] {
  if (!transitionsByZone) {
    transitionsByZone = new Map();
    for (const t of denseTransitions()) {
      const list = transitionsByZone.get(t.zone) ?? [];
      list.push(t.at);
      transitionsByZone.set(t.zone, list);
    }
  }
  return transitionsByZone.get(zone) ?? [];
}

const T_2024 = Date.UTC(2024, 0, 1);
const T_2028 = Date.UTC(2028, 0, 1);

/** An instant: uniform over 2024-2027, or within three days of a change in the zone. */
function baseInstant(rng: Rng, zone: string): number {
  const changes = transitionsOf(zone).filter((t) => t >= T_2024 && t < T_2028);
  if (changes.length > 0 && rng.chance(0.4)) return rng.pick(changes) + rng.int(-3 * MS_PER_DAY, 3 * MS_PER_DAY);
  return T_2024 + Math.floor(rng.next() * (T_2028 - T_2024));
}

const clock = (hhmmText: string): { hour: number; minute: number } | null => {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmmText);
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
};

/** Today's shift start in the zone, by the same public functions the reducer uses; null when there is none. */
function startOf(schedule: ShiftSchedule, now: number, zone: string): number | null {
  try {
    const p = zonedDateTimeParts(now, zone);
    const day = schedule[WEEKDAY_KEYS[new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()]!];
    const c = day ? clock(day.start) : null;
    if (!c) return null;
    return instantForZonedDateTime({ year: p.year, month: p.month, day: p.day, hour: c.hour, minute: c.minute, second: 0 }, zone).getTime();
  } catch {
    return null;
  }
}

/** A `now` that lands on the edges of the window when there is one. */
function pickNow(rng: Rng, schedule: ShiftSchedule, bufferMin: number, zone: string): number {
  const base = baseInstant(rng, zone);
  const start = startOf(schedule, base, zone);
  if (start === null || rng.chance(0.15)) return base;
  const buffer = Math.max(0, bufferMin) * MIN;
  const offset = rng.weighted<() => number>([
    [() => rng.pick([-1, 0, 1, -MIN, MIN]), 40],
    [() => rng.pick([buffer - 1, buffer, buffer + 1, buffer - MIN, buffer + MIN]), 30],
    [() => rng.int(-2 * 3_600_000, buffer + 2 * 3_600_000), 20],
    [() => rng.pick([MS_PER_DAY, -MS_PER_DAY, MS_PER_DAY - 1]), 10],
  ])();
  return start + offset;
}

function randomBuffer(rng: Rng): number {
  return rng.weighted<() => number>([
    [() => rng.pick([30, 0, 5, 60, 240]), 55],
    [() => rng.int(0, 240), 30],
    [() => rng.pick([-5, 0.5, 1e9, -1]), 8],
    [() => rng.pick([2.5, 29.999, 1 / 3]), 7],
  ])();
}

function randomState(rng: Rng, now: number, start: number | null): ShiftMonitorState {
  const pick = <T>(items: Array<() => T>): T => rng.pick(items)();
  return {
    ackedFor: pick<number | null>([() => null, () => null, () => (start ?? now), () => (start ?? now) + rng.pick([1, -1]), () => (start ?? now) - MS_PER_DAY, () => rng.int(0, 2e12)]),
    snoozedUntil: pick<number | null>([() => null, () => null, () => now - 1, () => now, () => now + 1, () => now + 5 * MIN, () => now - 5 * MIN, () => rng.int(0, 2e12)]),
    prompting: rng.chance(0.3),
  };
}

// ---------------------------------------------------------------------------
// tickShiftMonitor and friends
// ---------------------------------------------------------------------------

interface TickIn {
  schedule: ShiftSchedule | null;
  bufferMin: number;
  state: ShiftMonitorState;
  nowMs: number;
  timeZone: string;
  nudgeIntervalMs?: number;
}

const zoneFor = (rng: Rng): string => rng.weighted<() => string>([[() => rng.pick(SHIFT_ZONES), 92], [() => rng.pick(BAD_ZONES), 8]])();

function randomTick(rng: Rng): TickIn {
  const timeZone = zoneFor(rng);
  const schedule = rng.chance(0.04) ? null : randomSchedule(rng);
  const bufferMin = randomBuffer(rng);
  const nowMs = rng.chance(0.015) ? rng.pick([9e15, -9e15, 8.64e15 + 1]) : pickNow(rng, schedule ?? NINE_TO_SIX, bufferMin, timeZone);
  const start = schedule ? startOf(schedule, nowMs, timeZone) : null;
  const state = rng.chance(0.4) ? { ...INITIAL_STATE } : randomState(rng, nowMs, start);
  const tick: TickIn = { schedule, bufferMin, state, nowMs, timeZone };
  if (rng.chance(0.25)) tick.nudgeIntervalMs = rng.pick([MIN, 5 * MIN, 600_000, 0, 1234.5]);
  return tick;
}

const IST_MON_9 = Date.UTC(2026, 5, 1, 3, 30);

function tickEdge(): TickIn[] {
  const base = { schedule: NINE_TO_SIX, bufferMin: 30, state: INITIAL_STATE, timeZone: 'Asia/Kolkata' };
  const out: TickIn[] = [{ ...base, schedule: null, nowMs: IST_MON_9 }, { ...base, schedule: EMPTY_SCHEDULE, nowMs: IST_MON_9 }];
  // The window edges, both inclusive, in a zone with no DST, then in New York across a change.
  const buffer = 30 * MIN;
  for (const delta of [-MIN, -1, 0, 1, 15 * MIN, buffer - 1, buffer, buffer + 1, buffer + MIN, 2 * 3_600_000, -2 * 3_600_000, MS_PER_DAY, -MS_PER_DAY]) {
    out.push({ ...base, nowMs: IST_MON_9 + delta });
    out.push({ ...base, nowMs: IST_MON_9 + delta, state: { ackedFor: IST_MON_9, snoozedUntil: null, prompting: false } });
    out.push({ ...base, nowMs: IST_MON_9 + delta, state: { ackedFor: null, snoozedUntil: IST_MON_9 + 10 * MIN, prompting: false } });
    out.push({ ...base, nowMs: IST_MON_9 + delta, state: { ackedFor: null, snoozedUntil: null, prompting: true } });
  }
  for (const nowMs of [Date.UTC(2026, 5, 6, 4, 30), Date.UTC(2026, 5, 7, 4, 30), Date.UTC(2026, 5, 5, 12, 30)]) out.push({ ...base, nowMs });
  out.push({ ...base, bufferMin: 0, nowMs: IST_MON_9 }, { ...base, bufferMin: 0, nowMs: IST_MON_9 + 1 }, { ...base, bufferMin: -10, nowMs: IST_MON_9 });
  out.push({ ...base, bufferMin: 30, nowMs: IST_MON_9, nudgeIntervalMs: 60_000 });
  for (const timeZone of BAD_ZONES) out.push({ ...base, timeZone, nowMs: IST_MON_9 });
  out.push({ ...base, nowMs: 9e15 }, { ...base, nowMs: -9e15 }, { ...base, schedule: null, nowMs: 9e15 });
  // New York: the 2:30 start does not exist on 2026-03-08 and exists twice on 2026-11-01.
  const sched = everyDay('02:30', '09:00');
  for (const nowMs of [Date.UTC(2026, 2, 8, 7, 30), Date.UTC(2026, 2, 8, 8, 30), Date.UTC(2026, 2, 8, 9, 30), Date.UTC(2026, 10, 1, 6, 30), Date.UTC(2026, 10, 1, 7, 30), Date.UTC(2026, 10, 1, 8, 0)]) {
    out.push({ schedule: sched, bufferMin: 60, state: INITIAL_STATE, nowMs, timeZone: 'America/New_York' });
  }
  return out;
}

interface WindowIn { schedule: ShiftSchedule; nowMs: number; timeZone: string }

function randomWindow(rng: Rng): WindowIn {
  const timeZone = zoneFor(rng);
  const schedule = randomSchedule(rng);
  const nowMs = rng.chance(0.012) ? 9e15 : pickNow(rng, schedule, rng.pick([0, 30, 60]), timeZone);
  return { schedule, nowMs, timeZone };
}

interface AckIn { state: ShiftMonitorState; schedule: ShiftSchedule; nowMs: number; timeZone: string }

function randomAck(rng: Rng): AckIn {
  const w = randomWindow(rng);
  return { state: randomState(rng, w.nowMs, startOf(w.schedule, w.nowMs, w.timeZone)), ...w };
}

interface SnoozeIn { state: ShiftMonitorState; nowMs: number; nudgeIntervalMs?: number }

function randomSnooze(rng: Rng): SnoozeIn {
  const nowMs = rng.chance(0.03) ? 9e15 : T_2024 + Math.floor(rng.next() * (T_2028 - T_2024));
  const input: SnoozeIn = { state: randomState(rng, nowMs, null), nowMs };
  if (rng.chance(0.5)) input.nudgeIntervalMs = rng.pick([MIN, 7 * MIN, 0, 1e9, 0.5, -MIN]);
  return input;
}

// ---------------------------------------------------------------------------
// Whole-day sequences against the reducer, wired the way `ShiftMonitor` wires it
// ---------------------------------------------------------------------------

type Step =
  | { op: 'tick'; nowMs: number }
  | { op: 'yes'; nowMs: number }
  | { op: 'notYet'; nowMs: number }
  | { op: 'dismiss' };

interface SequenceIn { schedule: ShiftSchedule; bufferMin: number; timeZone: string; steps: Step[] }

/** `ShiftMonitor.tick` / `onUserDecision` (shift/index.ts) around the pure reducer. */
function runSequence(input: SequenceIn): unknown[] {
  let state: ShiftMonitorState = { ...INITIAL_STATE };
  let visible = false;
  const out: unknown[] = [];
  for (const step of input.steps) {
    if (step.op === 'tick') {
      state = { ...state, prompting: visible };
      const action: ShiftAction = tickShiftMonitor({ schedule: input.schedule, bufferMin: input.bufferMin, state, now: new Date(step.nowMs), timeZone: input.timeZone, nudgeIntervalMs: 300_000 });
      if (action.kind === 'show') { visible = true; state = { ...state, prompting: true }; }
      else if (action.kind === 'hide') { visible = false; state = expire(state); }
      out.push({ action, state });
    } else if (step.op === 'yes') {
      state = ackToday(state, input.schedule, new Date(step.nowMs), input.timeZone);
      visible = false;
      out.push({ state });
    } else if (step.op === 'notYet') {
      state = snooze(state, new Date(step.nowMs), 300_000);
      visible = false;
      out.push({ state });
    } else {
      visible = false;
      out.push({ state });
    }
  }
  return out;
}

function randomSequence(rng: Rng): SequenceIn {
  const timeZone = rng.pick(SHIFT_ZONES);
  const schedule = rng.chance(0.5) ? NINE_TO_SIX : randomSchedule(rng);
  const bufferMin = rng.pick([30, 30, 0, 60, 15]);
  const first = pickNow(rng, schedule, bufferMin, timeZone) - rng.int(0, 2 * 3_600_000);
  const steps: Step[] = [];
  let now = first;
  for (let i = rng.int(3, 12); i > 0; i--) {
    now += rng.pick([30_000, 30_000, 30_000, MIN, 5 * MIN, 12 * MIN, 3_600_000, MS_PER_DAY]);
    steps.push(rng.weighted<() => Step>([
      [() => ({ op: 'tick', nowMs: now }), 78],
      [() => ({ op: 'yes', nowMs: now }), 8],
      [() => ({ op: 'notYet', nowMs: now }), 10],
      [() => ({ op: 'dismiss' }), 4],
    ])());
  }
  return { schedule, bufferMin, timeZone, steps };
}

function sequenceEdge(): SequenceIn[] {
  const steps = (...times: number[]): Step[] => times.map((nowMs) => ({ op: 'tick', nowMs }));
  const t = (h: number, m: number): number => Date.UTC(2026, 5, 1, h, m) - 330 * MIN; // IST wall clock on Mon 2026-06-01
  return [
    { schedule: NINE_TO_SIX, bufferMin: 30, timeZone: 'Asia/Kolkata', steps: [...steps(t(8, 59), t(9, 0), t(9, 1)), { op: 'yes', nowMs: t(9, 2) }, ...steps(t(9, 15), t(9, 30), t(9, 31))] },
    { schedule: NINE_TO_SIX, bufferMin: 30, timeZone: 'Asia/Kolkata', steps: [...steps(t(9, 0)), { op: 'notYet', nowMs: t(9, 0) }, ...steps(t(9, 4), t(9, 6), t(9, 7))] },
    { schedule: NINE_TO_SIX, bufferMin: 30, timeZone: 'Asia/Kolkata', steps: [{ op: 'notYet', nowMs: t(9, 25) }, ...steps(t(9, 28), t(9, 31), t(10, 0))] },
    { schedule: NINE_TO_SIX, bufferMin: 30, timeZone: 'Asia/Kolkata', steps: [...steps(t(9, 0), t(9, 29), t(9, 30), t(9, 31)), { op: 'dismiss' }, ...steps(t(9, 32))] },
    { schedule: EMPTY_SCHEDULE, bufferMin: 30, timeZone: 'UTC', steps: steps(t(9, 0), t(9, 1)) },
  ];
}

// ---------------------------------------------------------------------------
// Untracked nudge
// ---------------------------------------------------------------------------

const T0 = Date.UTC(2026, 7, 10, 5, 0, 0);

function randomUntrackedState(rng: Rng, now: number): UntrackedNudgeState {
  const pick = <T>(items: Array<() => T>): T => rng.pick(items)();
  return {
    activeSince: pick<number | null>([() => null, () => null, () => now, () => now - 10 * MIN, () => now - 10 * MIN + 1, () => now - 10 * MIN - 1, () => now - rng.int(0, 30 * MIN), () => now + 5]),
    snoozedUntil: pick<number | null>([() => null, () => null, () => now - 1, () => now, () => now + 1, () => now + 30 * MIN, () => now - 30 * MIN]),
    prompting: rng.chance(0.3),
  };
}

function randomUntrackedTick(rng: Rng): UntrackedTickInput {
  const now = T0 + rng.int(-MS_PER_DAY, MS_PER_DAY) + (rng.chance(0.2) ? 0.5 : 0);
  return {
    state: randomUntrackedState(rng, now),
    now,
    inShift: rng.chance(0.75),
    tracking: rng.chance(0.2),
    idleSeconds: rng.pick([0, 2, 59, 59.999, 60, 60.001, 61, 600, 15 * 60, 0.5]),
    attentionBusy: rng.chance(0.2),
  };
}

const working = (over: Partial<UntrackedTickInput> = {}): UntrackedTickInput => ({ state: UNTRACKED_INITIAL_STATE, now: T0, inShift: true, tracking: false, idleSeconds: 2, attentionBusy: false, ...over });

function untrackedEdge(): UntrackedTickInput[] {
  const out: UntrackedTickInput[] = [];
  for (const state of [UNTRACKED_INITIAL_STATE, { activeSince: T0 - 10 * MIN, snoozedUntil: null, prompting: false }, { activeSince: T0 - 10 * MIN + 1, snoozedUntil: null, prompting: false }, { activeSince: T0 - 10 * MIN, snoozedUntil: T0, prompting: false }, { activeSince: T0 - 10 * MIN, snoozedUntil: T0 + 1, prompting: false }, { activeSince: T0 - 10 * MIN, snoozedUntil: null, prompting: true }, { activeSince: T0 - 20 * MIN, snoozedUntil: T0 - 1, prompting: false }]) {
    for (const over of [{}, { tracking: true }, { inShift: false }, { idleSeconds: 59.999 }, { idleSeconds: 60 }, { attentionBusy: true }, { attentionBusy: true, idleSeconds: 60 }]) out.push(working({ state, ...over }));
  }
  return out;
}

/** A tick of a sequence: the state is whatever the previous steps left, so it is not an input. */
type SequenceTick = Omit<UntrackedTickInput, 'state'>;
interface UntrackedSequenceIn { steps: Array<{ op: 'tick'; input: SequenceTick } | { op: 'accept' } | { op: 'snooze'; nowMs: number; snoozeMs?: number }> }

function runUntrackedSequence(input: UntrackedSequenceIn): unknown[] {
  let state: UntrackedNudgeState = UNTRACKED_INITIAL_STATE;
  const out: unknown[] = [];
  for (const step of input.steps) {
    if (step.op === 'tick') {
      const result = tickUntrackedNudge({ ...step.input, state });
      state = result.state;
      out.push(result);
    } else if (step.op === 'accept') {
      state = acceptUntrackedNudge(state);
      out.push({ state });
    } else {
      state = step.snoozeMs === undefined ? snoozeUntrackedNudge(state, step.nowMs) : snoozeUntrackedNudge(state, step.nowMs, step.snoozeMs);
      out.push({ state });
    }
  }
  return out;
}

function randomUntrackedSequence(rng: Rng): UntrackedSequenceIn {
  const steps: UntrackedSequenceIn['steps'] = [];
  let now = T0 + rng.int(-MS_PER_DAY, MS_PER_DAY);
  const mood = { inShift: rng.chance(0.85), tracking: rng.chance(0.1), attentionBusy: rng.chance(0.1) };
  for (let i = rng.int(4, 18); i > 0; i--) {
    now += rng.pick([MIN, MIN, MIN, 30_000, 5 * MIN, 12 * MIN, 31 * MIN]);
    if (rng.chance(0.06)) mood.inShift = !mood.inShift;
    if (rng.chance(0.06)) mood.tracking = !mood.tracking;
    if (rng.chance(0.1)) mood.attentionBusy = !mood.attentionBusy;
    steps.push(rng.weighted<() => UntrackedSequenceIn['steps'][number]>([
      [() => ({ op: 'tick', input: { now, ...mood, idleSeconds: rng.pick([0, 2, 5, 30, 59, 60, 600]) } }), 84],
      [() => ({ op: 'accept' }), 5],
      [() => (rng.chance(0.5) ? { op: 'snooze', nowMs: now } : { op: 'snooze', nowMs: now, snoozeMs: rng.pick([MIN, 5 * MIN, 0]) }), 11],
    ])());
  }
  return { steps };
}

const tickOf = ({ state: _state, ...rest }: UntrackedTickInput): SequenceTick => rest;

function untrackedSequenceEdge(): UntrackedSequenceIn[] {
  const ticks = (n: number, over: Partial<UntrackedTickInput> = {}): UntrackedSequenceIn['steps'] => Array.from({ length: n + 1 }, (_, i) => ({ op: 'tick' as const, input: tickOf(working({ ...over, now: T0 + i * MIN })) }));
  return [
    { steps: ticks(9) }, { steps: ticks(10) }, { steps: ticks(30, { tracking: true }) }, { steps: ticks(30, { inShift: false }) }, { steps: ticks(10, { attentionBusy: true }) },
    { steps: [...ticks(10), { op: 'snooze', nowMs: T0 + 10 * MIN }, ...Array.from({ length: 35 }, (_, i) => ({ op: 'tick' as const, input: tickOf(working({ now: T0 + (11 + i) * MIN })) }))] },
    { steps: [...ticks(10), { op: 'accept' }, ...ticks(3)] },
  ];
}

// ---------------------------------------------------------------------------

export const specs: FnSpec<any>[] = [
  {
    module: 'shift',
    fn: 'tickShiftMonitor',
    edge: tickEdge,
    random: randomTick,
    call: ({ nowMs, nudgeIntervalMs, ...rest }: TickIn) =>
      tickShiftMonitor({ ...rest, now: new Date(nowMs), ...(nudgeIntervalMs === undefined ? {} : { nudgeIntervalMs }) }),
  },
  {
    module: 'shift',
    fn: 'resolveShiftWindow',
    edge: (): WindowIn[] => [
      { schedule: NINE_TO_SIX, nowMs: IST_MON_9 + 3 * 3_600_000, timeZone: 'Asia/Kolkata' },
      { schedule: NINE_TO_SIX, nowMs: Date.UTC(2026, 5, 6, 6, 30), timeZone: 'Asia/Kolkata' },
      { schedule: everyDay('22:00', '23:59'), nowMs: IST_MON_9, timeZone: 'UTC' },
      { schedule: everyDay('09:00', '09:00'), nowMs: IST_MON_9, timeZone: 'UTC' },
      { schedule: everyDay('18:00', '09:00'), nowMs: IST_MON_9, timeZone: 'UTC' },
      { schedule: everyDay('02:00', '03:00'), nowMs: Date.UTC(2026, 2, 8, 12), timeZone: 'America/New_York' },
      { schedule: everyDay('01:00', '02:30'), nowMs: Date.UTC(2026, 10, 1, 12), timeZone: 'America/New_York' },
      { schedule: NINE_TO_SIX, nowMs: 9e15, timeZone: 'UTC' },
      { schedule: NINE_TO_SIX, nowMs: IST_MON_9, timeZone: '' },
    ],
    random: randomWindow,
    call: ({ schedule, nowMs, timeZone }: WindowIn) => resolveShiftWindow(schedule, new Date(nowMs), timeZone),
  },
  {
    module: 'shift',
    fn: 'ackToday',
    edge: (): AckIn[] => [
      { state: { ackedFor: null, snoozedUntil: 12345, prompting: true }, schedule: NINE_TO_SIX, nowMs: Date.UTC(2026, 5, 1, 4, 0), timeZone: 'Asia/Kolkata' },
      { state: { ackedFor: null, snoozedUntil: 12345, prompting: true }, schedule: NINE_TO_SIX, nowMs: Date.UTC(2026, 5, 6, 4, 0), timeZone: 'Asia/Kolkata' },
      { state: INITIAL_STATE, schedule: NINE_TO_SIX, nowMs: Date.UTC(2026, 5, 1, 4, 0), timeZone: 'Mars/Olympus' },
      { state: INITIAL_STATE, schedule: everyDay('02:30', '09:00'), nowMs: Date.UTC(2026, 2, 8, 12), timeZone: 'America/New_York' },
      { state: INITIAL_STATE, schedule: NINE_TO_SIX, nowMs: 9e15, timeZone: 'UTC' },
    ],
    random: randomAck,
    call: ({ state, schedule, nowMs, timeZone }: AckIn) => ackToday(state, schedule, new Date(nowMs), timeZone),
  },
  {
    module: 'shift',
    fn: 'snooze',
    edge: (): SnoozeIn[] => [
      { state: { ackedFor: null, snoozedUntil: null, prompting: true }, nowMs: IST_MON_9 },
      { state: { ackedFor: null, snoozedUntil: null, prompting: true }, nowMs: IST_MON_9, nudgeIntervalMs: 7 * MIN },
      { state: { ackedFor: 5, snoozedUntil: 9, prompting: false }, nowMs: 0, nudgeIntervalMs: 0 },
      { state: INITIAL_STATE, nowMs: 9e15 },
    ],
    random: randomSnooze,
    call: ({ state, nowMs, nudgeIntervalMs }: SnoozeIn) => (nudgeIntervalMs === undefined ? snooze(state, new Date(nowMs)) : snooze(state, new Date(nowMs), nudgeIntervalMs)),
  },
  {
    module: 'shift',
    fn: 'expire',
    edge: (): Array<{ state: ShiftMonitorState }> => [{ state: INITIAL_STATE }, { state: { ackedFor: 7, snoozedUntil: 999, prompting: true } }, { state: { ackedFor: null, snoozedUntil: 999, prompting: false } }],
    random: (rng: Rng) => ({ state: randomState(rng, T0, null) }),
    call: ({ state }: { state: ShiftMonitorState }) => expire(state),
  },
  { module: 'shift', fn: 'shiftSequence', edge: sequenceEdge, random: randomSequence, call: runSequence },
  { module: 'shift', fn: 'tickUntrackedNudge', edge: untrackedEdge, random: randomUntrackedTick, call: (i: UntrackedTickInput) => tickUntrackedNudge(i) },
  { module: 'shift', fn: 'untrackedSequence', edge: untrackedSequenceEdge, random: randomUntrackedSequence, call: runUntrackedSequence },
  {
    module: 'shift',
    fn: 'snoozeUntrackedNudge',
    edge: (): Array<{ state: UntrackedNudgeState; nowMs: number; snoozeMs?: number }> => [
      { state: UNTRACKED_INITIAL_STATE, nowMs: T0 }, { state: { activeSince: 5, snoozedUntil: 9, prompting: true }, nowMs: T0, snoozeMs: 0 }, { state: UNTRACKED_INITIAL_STATE, nowMs: 0.5, snoozeMs: 0.25 },
    ],
    random: (rng: Rng) => {
      const nowMs = T0 + rng.int(-MS_PER_DAY, MS_PER_DAY) + rng.pick([0, 0.5]);
      const base = { state: randomUntrackedState(rng, nowMs), nowMs };
      return rng.chance(0.5) ? base : { ...base, snoozeMs: rng.pick([MIN, 0, 1e9, 0.1]) };
    },
    call: ({ state, nowMs, snoozeMs }: { state: UntrackedNudgeState; nowMs: number; snoozeMs?: number }) => (snoozeMs === undefined ? snoozeUntrackedNudge(state, nowMs) : snoozeUntrackedNudge(state, nowMs, snoozeMs)),
  },
  {
    module: 'shift',
    fn: 'acceptUntrackedNudge',
    edge: (): Array<{ state: UntrackedNudgeState }> => [{ state: UNTRACKED_INITIAL_STATE }, { state: { activeSince: 5, snoozedUntil: 9, prompting: true } }],
    random: (rng: Rng) => ({ state: randomUntrackedState(rng, T0) }),
    call: ({ state }: { state: UntrackedNudgeState }) => acceptUntrackedNudge(state),
  },
];
