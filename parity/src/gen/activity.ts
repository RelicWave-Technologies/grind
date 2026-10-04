import { ActivityAggregator, coefficientOfVariation, type ActivitySample } from '../../../legacy/agent/src/main/services/activity/aggregator';
import { MinuteSealer } from '../../../legacy/agent/src/main/services/activity/minuteSealer';
import { activityPercent, type ActivityWindow } from '../../../legacy/agent/src/main/services/activity/percent';
import { ActiveWindowTracker, type ActiveWindowObservation } from '../../../legacy/agent/src/main/services/activity/activeWindow';
import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';
import { MIN, T0, maybeFrac } from './common';
import { clockStart, clockStep, pixel, plain, smallCount } from './seq';

const module = 'activity';

// --- coefficientOfVariation ---------------------------------------------------

type CvIn = { values: number[] };

const value = (rng: Rng): number =>
  rng.weighted<() => number>([
    [() => rng.int(0, 2000), 40],
    [() => maybeFrac(rng, rng.int(0, 5000), 0.9), 30],
    [() => rng.pick([0, 0, 100, 100, 100, 1e-9, 1e9, 1e150, 1e154, 1e-200, 0.1, 0.2, 1 / 3, -5, -100]), 20],
    [() => (rng.next() - 0.5) * 10 ** rng.int(-5, 20), 10],
  ])();

const cvSpec: FnSpec<CvIn> = {
  module,
  fn: 'coefficientOfVariation',
  edge: () => [
    { values: [] }, { values: [5] }, { values: [100, 100, 100, 100] }, { values: [10, 400, 30, 600, 20] }, { values: [0, 0, 0] },
    { values: [1, -1] }, { values: [-5, 5, -5, 5] }, { values: [0.1, 0.2, 0.3] }, { values: [1e308, 1e308] }, { values: [1e-300, 2e-300, 3e-300] },
    { values: [1791133383891.2627, 1791133448770.0293, 1791133430180.8308] },
  ],
  random: (rng) => {
    const n = rng.weighted([[2, 15], [3, 25], [4, 20], [8, 20], [30, 15], [0, 2], [1, 3]] as const);
    const mode = rng.int(0, 3);
    const base = value(rng);
    return { values: Array.from({ length: n }, () => (mode === 0 ? base : mode === 1 ? base + rng.int(0, 3) : value(rng))) };
  },
  call: ({ values }) => plain(coefficientOfVariation(values)),
};

// --- activityPercent -----------------------------------------------------------

const pct = (rng: Rng): number =>
  rng.weighted<() => number>([
    [() => rng.int(0, 500), 30],
    [() => rng.pick([0, 0, 1, 40, 80, 120, 240, 6000, 12000, 100000, 1e9]), 30],
    [() => maybeFrac(rng, rng.int(0, 20000), 0.9), 25],
    [() => rng.pick([0.5, 0.25, 1.5, 2.5, 49.5, 50.5, 0.49999999999999994, 1e-9, 1e300, 1 / 3]), 15],
  ])();

const percentSpec: FnSpec<ActivityWindow> = {
  module,
  fn: 'activityPercent',
  edge: () => [
    { minutes: 0, keystrokes: 0, clicks: 0, mouseDistancePx: 0, scrollEvents: 0 },
    { minutes: 2, keystrokes: 240, clicks: 80, mouseDistancePx: 0, scrollEvents: 0 },
    { minutes: 1, keystrokes: 100000, clicks: 0, mouseDistancePx: 0, scrollEvents: 0 },
    { minutes: 1, keystrokes: 60, clicks: 0, mouseDistancePx: 0, scrollEvents: 0 },
    { minutes: 1, keystrokes: 0, clicks: 0, mouseDistancePx: 6000, scrollEvents: 0 },
    { minutes: 2, keystrokes: 120, clicks: 0, mouseDistancePx: 0, scrollEvents: 0 },
    { minutes: -1, keystrokes: 5, clicks: 5, mouseDistancePx: 5, scrollEvents: 5 },
    { minutes: 1, keystrokes: 0.6, clicks: 0, mouseDistancePx: 0, scrollEvents: 0 },
    { minutes: 1, keystrokes: 180, clicks: 0, mouseDistancePx: 0, scrollEvents: 0 },
    { minutes: 1, keystrokes: 0, clicks: 0, mouseDistancePx: 0, scrollEvents: 20.2 },
  ],
  random: (rng) => ({
    minutes: rng.weighted<number>([[1, 25], [2, 15], [rng.int(1, 120), 30], [maybeFrac(rng, rng.int(1, 30), 1), 15], [0, 6], [-rng.int(1, 5), 3], [1e-9, 3], [1e300, 3]]),
    keystrokes: pct(rng), clicks: pct(rng), mouseDistancePx: pct(rng), scrollEvents: pct(rng),
  }),
  call: (w) => plain(activityPercent(w)),
};

// --- ActivityAggregator --------------------------------------------------------

type AggEvent =
  | { t: 'key'; ts: number }
  | { t: 'click' }
  | { t: 'scroll' }
  | { t: 'move'; ts: number; x: number; y: number }
  | { t: 'flush'; bucket: number }
  | { t: 'isEmpty' };
type AggIn = { events: AggEvent[] };

function genAggEvents(rng: Rng): AggEvent[] {
  const events: AggEvent[] = [];
  const total = smallCount(rng, 1, 45);
  let now = clockStart(rng);
  let x = pixel(rng);
  let y = pixel(rng);
  const style = rng.int(0, 3);
  for (let i = 0; i < total; i++) {
    now += rng.weighted<number>([[rng.int(0, 400), 60], [100, style === 1 ? 40 : 5], [0, 8], [-rng.int(1, 300), 5], [maybeFrac(rng, rng.int(0, 90), 1), 12]]);
    const kind = rng.weighted<AggEvent['t']>([['key', 28], ['move', 34], ['click', 8], ['scroll', 6], ['flush', 12], ['isEmpty', 12]]);
    if (kind === 'key') events.push({ t: 'key', ts: now });
    else if (kind === 'move') {
      if (rng.chance(style === 2 ? 0.1 : 0.7)) { x += rng.int(-60, 60); y += rng.int(-60, 60); }
      else { x = pixel(rng); y = pixel(rng); }
      events.push({ t: 'move', ts: now, x, y });
    } else if (kind === 'flush') events.push({ t: 'flush', bucket: maybeFrac(rng, Math.floor(now / MIN) * MIN, 0.3) });
    else events.push({ t: kind } as AggEvent);
  }
  return events;
}

const aggEdge = (): AggIn[] => {
  const keys = (ts: number[]): AggEvent[] => ts.map((t) => ({ t: 'key', ts: t }));
  const mv = (pts: Array<[number, number, number]>): AggEvent[] => pts.map(([ts, x, y]) => ({ t: 'move', ts, x, y }));
  const flush: AggEvent = { t: 'flush', bucket: 0 };
  return [
    { events: [{ t: 'key', ts: 0 }, { t: 'key', ts: 100 }, { t: 'click' }, { t: 'click' }, { t: 'scroll' }, { t: 'flush', bucket: 1000 }] },
    { events: [...mv([[0, 0, 0], [10, 3, 4], [20, 6, 8]]), flush] },
    { events: [{ t: 'key', ts: 0 }, { t: 'click' }, flush, { t: 'flush', bucket: 60000 }, { t: 'isEmpty' }] },
    { events: [...keys([0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]), flush] },
    { events: [...keys([0, 80, 130, 600, 660, 1400, 1450]), flush] },
    { events: [...keys([0, 100]), flush] },
    { events: [...mv(Array.from({ length: 11 }, (_, i): [number, number, number] => [i * 10, i * 5, 0])), flush] },
    { events: [...mv([[0, 0, 0], [10, 50, 0], [20, 50, 50], [30, 0, 50], [40, 0, 0]]), flush] },
    { events: [{ t: 'key', ts: 0 }, flush] },
    // same timestamp (dt = 0): distance counted, no speed recorded; isEmpty depends on both
    { events: [...mv([[5, 0, 0], [5, 10, 10]]), { t: 'isEmpty' }, flush, { t: 'isEmpty' }] },
    // a move to the same point: distance 0, one speed sample of 0
    { events: [...mv([[0, 7, 7], [10, 7, 7]]), { t: 'isEmpty' }, flush] },
    // out-of-order timestamps (dt < 0)
    { events: [...mv([[100, 0, 0], [50, 30, 40]]), flush] },
    // half-pixel totals round up (Math.round)
    { events: [...mv([[0, 0, 0], [1, 0.5, 0]]), flush] },
    { events: [...mv([[0, 0, 0], [1, -0.5, 0]]), flush] },
    { events: [...mv([[0, 0, 0], [1, 1e150, 1e150], [2, 0, 0]]), flush] },
    { events: [...mv([[0, 0, 0], [1, 1e-200, 1e-200]]), flush] },
    { events: [...mv([[0, 0, 0], [1, 3, 4], [2, 6, 8], [3, 9, 12]]), flush] },
    { events: [...mv([[1791133383891.2627, 100, 100], [1791133383941.0293, 130.5, 140.25], [1791133384000.8308, 200, 90]]), flush] },
    { events: [] },
  ];
};

function runAgg(events: AggEvent[]): unknown[] {
  const a = new ActivityAggregator();
  return events.map((e): unknown => {
    switch (e.t) {
      case 'key': a.onKey(e.ts); return null;
      case 'click': a.onClick(); return null;
      case 'scroll': a.onScroll(); return null;
      case 'move': a.onMove(e.ts, e.x, e.y); return null;
      case 'flush': return a.flush(e.bucket);
      case 'isEmpty': return a.isEmpty();
    }
  });
}

const aggregatorSpec: FnSpec<AggIn> = {
  module,
  fn: 'aggregator',
  edge: aggEdge,
  random: (rng) => ({ events: genAggEvents(rng) }),
  call: ({ events }) => plain(runAgg(events)),
};

// --- MinuteSealer ----------------------------------------------------------------

type SealEvent =
  | { t: 'setRecording'; on: boolean; entryId: string | null }
  | { t: 'key'; ts: number }
  | { t: 'click' }
  | { t: 'scroll' }
  | { t: 'move'; ts: number; x: number; y: number }
  | { t: 'advance'; ms: number }
  | { t: 'setNow'; ms: number }
  | { t: 'tick' }
  | { t: 'sealPartial' };
type SealIn = { start: number; events: SealEvent[] };

function genSealEvents(rng: Rng): SealIn {
  const start = clockStart(rng);
  let now = start;
  const events: SealEvent[] = [];
  const total = smallCount(rng, 1, 50);
  const entries = ['e1', 'e2', 'entry-A', null, ''];
  for (let i = 0; i < total; i++) {
    const kind = rng.weighted<SealEvent['t']>([['key', 22], ['click', 10], ['scroll', 5], ['move', 14], ['setRecording', 10], ['advance', 14], ['setNow', 2], ['tick', 14], ['sealPartial', 6]]);
    switch (kind) {
      case 'setRecording': events.push({ t: 'setRecording', on: rng.chance(0.65), entryId: rng.pick(entries) }); break;
      case 'key': events.push({ t: 'key', ts: now + rng.int(0, 500) }); break;
      case 'move': events.push({ t: 'move', ts: now + rng.int(0, 500), x: rng.int(0, 2000), y: rng.int(0, 1200) }); break;
      case 'advance': { const ms = clockStep(rng); now += ms; events.push({ t: 'advance', ms }); break; }
      case 'setNow': { now = clockStart(rng); events.push({ t: 'setNow', ms: now }); break; }
      default: events.push({ t: kind } as SealEvent);
    }
  }
  return { start, events };
}

const sealEdge = (): SealIn[] => {
  const rec = (entryId: string | null): SealEvent => ({ t: 'setRecording', on: true, entryId });
  const adv = (ms: number): SealEvent => ({ t: 'advance', ms });
  const keys = (n: number, base: number): SealEvent[] => Array.from({ length: n }, (_, i) => ({ t: 'key', ts: base + i * 100 }));
  return [
    { start: 60_000, events: [rec('e1'), ...keys(10, 60_000), { t: 'click' }, adv(60_000), { t: 'tick' }] },
    { start: 60_000, events: [rec('e1'), ...keys(8, 60_000), { t: 'setRecording', on: false, entryId: null }, adv(60_000), { t: 'tick' }] },
    { start: 0, events: [rec('entry-A'), { t: 'key', ts: 100 }, { t: 'key', ts: 400 }, { t: 'setRecording', on: false, entryId: null }, adv(60_000), { t: 'tick' }] },
    { start: 0, events: [{ t: 'key', ts: 10 }, { t: 'click' }, { t: 'move', ts: 20, x: 5, y: 5 }, adv(60_000), { t: 'tick' }] },
    { start: 0, events: [rec('e1'), adv(60_000), { t: 'tick' }] },
    { start: 0, events: [rec('e1'), { t: 'click' }, adv(60_000), { t: 'tick' }, { t: 'click' }, adv(60_000), { t: 'tick' }] },
    { start: 0, events: [rec('e1'), { t: 'key', ts: 1000 }, { t: 'key', ts: 1200 }, adv(30_000), { t: 'sealPartial' }] },
    { start: 60_000, events: [rec('e1'), { t: 'key', ts: 60_100 }, { t: 'key', ts: 60_200 }, { t: 'key', ts: 60_300 }, { t: 'sealPartial' }, rec('e1'), { t: 'key', ts: 60_500 }, { t: 'key', ts: 60_600 }, adv(60_000), { t: 'tick' }] },
    { start: 60_000, events: [rec('e1'), { t: 'key', ts: 60_100 }, { t: 'sealPartial' }, { t: 'key', ts: 60_500 }, adv(60_000), { t: 'tick' }, { t: 'key', ts: 120_100 }, adv(60_000), { t: 'tick' }] },
    // a late tick (the interval is not minute aligned): the label is the floor of the previous tick
    { start: 30_000, events: [rec('e1'), { t: 'click' }, adv(59_999), { t: 'tick' }, { t: 'click' }, adv(60_001), { t: 'tick' }, { t: 'click' }, adv(61_000), { t: 'tick' }] },
    // the clock moves backwards
    { start: 600_000, events: [rec('e1'), { t: 'click' }, adv(-300_000), { t: 'tick' }, { t: 'click' }, adv(60_000), { t: 'tick' }] },
    // fractional clock
    { start: 1791133383891.2627, events: [rec('e1'), { t: 'click' }, adv(60_000.5), { t: 'tick' }, { t: 'click' }, adv(59_999.75), { t: 'tick' }] },
    { start: T0 + 0.5, events: [rec(null), { t: 'click' }, { t: 'sealPartial' }, { t: 'sealPartial' }] },
  ];
};

function runSealer({ start, events }: SealIn): unknown[] {
  let nowMs = start;
  let persisted: Array<{ sample: ActivitySample; entryId: string | null }> = [];
  const sealer = new MinuteSealer({ now: () => nowMs, persist: (sample, entryId) => persisted.push({ sample, entryId }) });
  return events.map((e) => {
    let ret: number | null = null;
    switch (e.t) {
      case 'setRecording': sealer.setRecording(e.on, e.entryId); break;
      case 'key': sealer.onKey(e.ts); break;
      case 'click': sealer.onClick(); break;
      case 'scroll': sealer.onScroll(); break;
      case 'move': sealer.onMove(e.ts, e.x, e.y); break;
      case 'advance': nowMs += e.ms; break;
      case 'setNow': nowMs = e.ms; break;
      case 'tick': ret = sealer.tick(); break;
      case 'sealPartial': ret = sealer.sealPartial(); break;
    }
    const step = { ret, persisted };
    persisted = [];
    return step;
  });
}

const sealerSpec: FnSpec<SealIn> = {
  module,
  fn: 'minuteSealer',
  edge: sealEdge,
  random: genSealEvents,
  call: (i) => plain(runSealer(i)),
};

// --- ActiveWindowTracker -----------------------------------------------------------

type WinEvent =
  | { t: 'observe'; obs: ActiveWindowObservation }
  | { t: 'dominantFor'; start: number; end: number }
  | { t: 'prune'; before: number }
  | { t: 'size' }
  | { t: 'clear' };
type WinIn = { max?: number; events: WinEvent[] };

const APPS: Array<[string | null, string | null]> = [
  ['Chrome', 'com.google.Chrome'], ['Chrome', 'com.google.Chrome.test'], ['VS Code', 'com.microsoft.VSCode'], ['Slack', null], [null, 'com.apple.finder'],
  [null, null], ['', ''], ['', 'com.x'], ['ab', 'c'], ['a', 'bc'], ['a\u0001b', 'c'], ['a', 'b\u0001c'], ['Terminal', 'com.apple.Terminal'], ['Chrome', null], [null, 'Chrome'],
];

function genObs(rng: Rng, ts: number): ActiveWindowObservation {
  const [app, appBundle] = rng.pick(APPS);
  const label = rng.int(0, 9);
  return {
    ts,
    app,
    appBundle,
    title: rng.chance(0.5) ? `title ${label}` : null,
    url: rng.chance(0.4) ? `https://x.test/${label}` : null,
  };
}

function genWinEvents(rng: Rng): WinIn {
  let now = clockStart(rng);
  const events: WinEvent[] = [];
  const total = smallCount(rng, 1, 45);
  for (let i = 0; i < total; i++) {
    const kind = rng.weighted<WinEvent['t']>([['observe', 50], ['dominantFor', 24], ['prune', 14], ['size', 6], ['clear', 2]]);
    if (kind === 'observe') {
      now += rng.weighted<number>([[rng.int(0, 15_000), 70], [10_000, 12], [0, 6], [-rng.int(1, 30_000), 8], [maybeFrac(rng, rng.int(0, 5000), 1), 14]]);
      events.push({ t: 'observe', obs: genObs(rng, now) });
    } else if (kind === 'dominantFor') {
      const start = Math.floor(now / MIN) * MIN + rng.pick([0, 0, -MIN, MIN, 1, -1, 30_000]);
      events.push({ t: 'dominantFor', start: maybeFrac(rng, start, 0.2), end: maybeFrac(rng, start + rng.pick([MIN, MIN, MIN, 0, 30_000, 5 * MIN, -MIN]), 0.2) });
    } else if (kind === 'prune') events.push({ t: 'prune', before: maybeFrac(rng, Math.floor(now / MIN) * MIN + rng.pick([0, 0, MIN, -MIN]), 0.2) });
    else events.push({ t: kind } as WinEvent);
  }
  return rng.chance(0.25) ? { max: rng.int(1, 8), events } : { events };
}

const winEdge = (): WinIn[] => {
  const o = (ts: number, app: string | null, appBundle: string | null = null, title: string | null = null, url: string | null = null): WinEvent => ({ t: 'observe', obs: { ts, app, appBundle, title, url } });
  const dom = (start: number, end: number): WinEvent => ({ t: 'dominantFor', start, end });
  return [
    { events: [dom(0, 60_000)] },
    { events: [o(0, 'Chrome', 'com.google.Chrome'), dom(0, 60_000)] },
    { events: [o(0, 'Chrome'), o(10_000, 'VS Code'), dom(0, 60_000)] },
    { events: [o(0, 'Chrome'), o(30_000, 'VS Code'), o(35_000, 'Chrome'), dom(0, 60_000)] },
    { events: [o(-5_000, 'Chrome'), o(50_000, 'VS Code'), dom(0, 60_000)] },
    { events: [o(0, 'Chrome', 'com.google.Chrome', 'tab one', 'https://a'), o(30_000, 'Chrome', 'com.google.Chrome', 'tab two', 'https://b'), dom(0, 60_000)] },
    { events: [o(-1_000, 'Chrome'), dom(0, 60_000)] },
    { events: [o(0, null, null), dom(0, 60_000)] },
    { events: [o(0, 'Chrome'), o(120_000, 'VS Code'), dom(0, 60_000)] },
    { events: [o(0, 'Chrome', 'com.google.Chrome'), o(30_000, 'Chrome', 'com.google.Chrome.test'), dom(0, 60_000)] },
    { events: [o(0, 'A'), o(10_000, 'B'), o(20_000, 'C'), o(70_000, 'D'), { t: 'prune', before: 60_000 }, { t: 'size' }, dom(60_000, 120_000)] },
    { max: 5, events: [...Array.from({ length: 20 }, (_, i) => o(i * 1000, `App${i}`)), { t: 'size' }] },
    { events: [o(0, 'Chrome'), o(20_000, null, null), o(50_000, 'VS Code'), dom(0, 60_000)] },
    { events: [o(0, 'VS Code'), o(40_000, 'Chrome'), o(41_000, 'VS Code'), o(42_000, 'Chrome'), o(43_000, 'VS Code'), o(44_000, 'Chrome'), o(45_000, 'VS Code'), dom(0, 60_000)] },
    // the tally key is `app + U+0001 + bundle`: ("ab","c") and ("a","bc") do NOT collide...
    { events: [o(0, 'ab', 'c', 'first'), o(20_000, 'a', 'bc', 'second'), o(30_000, 'zz', 'y'), dom(0, 60_000)] },
    // ...but names that contain U+0001 do: ("a\u0001b","c") and ("a","b\u0001c") share a key
    { events: [o(0, 'a\u0001b', 'c', 'first'), o(20_000, 'a', 'b\u0001c', 'second'), o(30_000, 'zz', 'y'), dom(0, 60_000)] },
    { events: [o(0, 'a\u0001b', 'c', 'first'), o(10_000, 'zz', 'y', 'mid'), o(20_000, 'a', 'b\u0001c', 'second'), o(30_000, 'q'), dom(0, 60_000)] },
    // a tie: the first key inserted wins
    { events: [o(0, 'First'), o(30_000, 'Second'), dom(0, 60_000)] },
    // out-of-order observations are sorted
    { events: [o(40_000, 'B'), o(0, 'A'), o(10_000, 'C'), dom(0, 60_000), { t: 'prune', before: 20_000 }, { t: 'size' }, dom(0, 60_000)] },
    // empty-string app is falsy
    { events: [o(0, '', ''), dom(0, 60_000), o(0, '', 'com.x'), dom(0, 60_000)] },
    { events: [o(0.5, 'A'), o(30_000.25, 'B'), o(30_000.5, 'A'), dom(0.25, 60_000.75), { t: 'clear' }, { t: 'size' }, dom(0, 60_000)] },
  ];
};

function runWin({ max, events }: WinIn): unknown[] {
  const t = max === undefined ? new ActiveWindowTracker() : new ActiveWindowTracker(max);
  return events.map((e): unknown => {
    switch (e.t) {
      case 'observe': t.observe(e.obs); return null;
      case 'dominantFor': return t.dominantFor(e.start, e.end);
      case 'prune': t.prune(e.before); return null;
      case 'size': return t.size();
      case 'clear': t.clear(); return null;
    }
  });
}

const activeWindowSpec: FnSpec<WinIn> = {
  module,
  fn: 'activeWindow',
  edge: winEdge,
  random: genWinEvents,
  call: (i) => plain(runWin(i)),
};

export const specs: FnSpec<any>[] = [cvSpec, percentSpec, aggregatorSpec, sealerSpec, activeWindowSpec];
