import { clampEntryToServerClock, DEFAULT_CLOCK_SKEW_MS, type TimeEntry } from '@grind/core';
import type { FnSpec } from '../fixture';
import { DELTAS, FRACTIONAL_ATS, MAX_EXACT, MAX_SAFE, MIN, T0, atFor, genEntry, makeEntry, seg, ts } from './common';

const NOW = T0;

type In = { entry: TimeEntry; nowMs: number; skewMs?: number };

const edgeEntries = (): TimeEntry[] => [
  // honest past entry
  makeEntry({ startedAt: NOW - 10 * MIN, endedAt: NOW - MIN, segments: [seg('s1', 'WORK', NOW - 10 * MIN, NOW - MIN)] }),
  // fast client clock
  makeEntry({ startedAt: NOW - 5 * MIN, endedAt: NOW + 60 * MIN, segments: [seg('s1', 'WORK', NOW - 5 * MIN, NOW + 60 * MIN)] }),
  // just inside / exactly on / just past the default ceiling
  makeEntry({ startedAt: NOW - 5 * MIN, endedAt: NOW + DEFAULT_CLOCK_SKEW_MS - 1, segments: [seg('s1', 'WORK', NOW - 5 * MIN, NOW + DEFAULT_CLOCK_SKEW_MS - 1)] }),
  makeEntry({ startedAt: NOW - 5 * MIN, endedAt: NOW + DEFAULT_CLOCK_SKEW_MS, segments: [seg('s1', 'WORK', NOW - 5 * MIN, NOW + DEFAULT_CLOCK_SKEW_MS)] }),
  makeEntry({ startedAt: NOW - 5 * MIN, endedAt: NOW + DEFAULT_CLOCK_SKEW_MS + 1, segments: [seg('s1', 'WORK', NOW - 5 * MIN, NOW + DEFAULT_CLOCK_SKEW_MS + 1)] }),
  // slow client clock
  makeEntry({ startedAt: NOW - 100 * MIN, endedAt: NOW - 50 * MIN, segments: [seg('s1', 'WORK', NOW - 100 * MIN, NOW - 50 * MIN)] }),
  // open segment with a future start
  makeEntry({ startedAt: NOW + 30 * MIN, segments: [seg('s1', 'WORK', NOW + 30 * MIN, null)] }),
  // both ends in the future: dropped
  makeEntry({ startedAt: NOW + 30 * MIN, endedAt: NOW + 90 * MIN, segments: [seg('s1', 'WORK', NOW + 30 * MIN, NOW + 90 * MIN)] }),
  // mixed
  makeEntry({
    startedAt: NOW - 20 * MIN,
    endedAt: NOW + 60 * MIN,
    segments: [seg('s1', 'WORK', NOW - 20 * MIN, NOW - 15 * MIN), seg('s2', 'MEETING', NOW - 10 * MIN, NOW + 60 * MIN)],
  }),
  // zero-length and inverted segments, no clamping involved
  makeEntry({ startedAt: NOW, segments: [seg('z', 'WORK', NOW, NOW), seg('n', 'WORK', NOW, NOW - 1), seg('ok', 'WORK', NOW, NOW + 1)] }),
  makeEntry({ startedAt: NOW, segments: [] }),
  // fractional timestamps from a real agent.db row
  makeEntry({
    startedAt: 1791133383891.2627,
    endedAt: 1791133448770.0293,
    segments: [seg('r1', 'WORK', 1791133383891.2627, 1791133430180.8308), seg('r2', 'MEETING', 1791133430180.8308, 1791133448770.0293)],
  }),
  makeEntry({ startedAt: 1791133383891.2627, segments: [seg('r1', 'WORK', 1791133383891.2627, null)] }),
  makeEntry({ startedAt: 0.5, endedAt: 0.75, segments: [seg('h', 'WORK', 0.5, 0.75), seg('z', 'WORK', 0.75, 0.75)] }),
  makeEntry({ startedAt: MAX_EXACT, endedAt: MAX_EXACT, segments: [seg('h', 'WORK', MAX_SAFE, MAX_EXACT)] }),
  makeEntry({ startedAt: -MAX_EXACT, endedAt: null, larkTaskGuid: undefined, segments: [seg('l', 'IDLE_TRIMMED', -MAX_EXACT, null)] }),
];

export const specs: FnSpec<any>[] = [
  {
    module: 'clamp',
    fn: 'clampEntryToServerClock',
    edge: (): In[] => {
      const cases: In[] = [];
      for (const entry of edgeEntries()) {
        cases.push({ entry, nowMs: NOW }, { entry, nowMs: NOW, skewMs: 0 }, { entry, nowMs: NOW, skewMs: -5 * MIN }, { entry, nowMs: NOW, skewMs: DEFAULT_CLOCK_SKEW_MS });
        cases.push({ entry, nowMs: MAX_SAFE, skewMs: 1 }, { entry, nowMs: MAX_EXACT, skewMs: 120_000 }, { entry, nowMs: -MAX_EXACT, skewMs: MAX_SAFE });
        for (const nowMs of FRACTIONAL_ATS) cases.push({ entry, nowMs }, { entry, nowMs, skewMs: 0.5 }, { entry, nowMs, skewMs: 1e-7 });
      }
      return cases;
    },
    random: (rng): In => {
      const entry = genEntry(rng);
      const nowMs = rng.chance(0.85) ? atFor(rng, entry) : ts(rng);
      const skew = rng.weighted<number | undefined>([[undefined, 50], [0, 10], [DEFAULT_CLOCK_SKEW_MS, 8], [rng.pick(DELTAS), 20], [-rng.int(1, 10 ** 6), 6], [MAX_SAFE, 3], [MAX_EXACT, 3]]);
      return skew === undefined ? { entry, nowMs } : { entry, nowMs, skewMs: skew };
    },
    call: ({ entry, nowMs, skewMs }: In) => clampEntryToServerClock(entry, nowMs, skewMs),
  },
];
