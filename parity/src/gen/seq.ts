import type { Rng } from '../prng';
import { DAY, MIN, T0, clip, maybeFrac } from './common';

/**
 * Helpers for the stateful generators (event sequences). A sequence is
 * generated from the seeded `Rng`, replayed against the real TypeScript, and the
 * state or output after EVERY event is recorded.
 */

/** A count in `[lo, hi]` biased to the small end. */
export function smallCount(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng.next() ** 2 * (hi - lo + 1));
}

/** A clock start: mostly a realistic fractional instant, sometimes an edge. */
export function clockStart(rng: Rng): number {
  return rng.weighted<() => number>([
    [() => maybeFrac(rng, T0 + rng.int(-DAY, DAY), 0.7), 70],
    [() => rng.pick([0, 59_999, 60_000, 60_001, 119_999.5, 1791133383891.2627, 1791133448770.0293]), 20],
    [() => maybeFrac(rng, rng.int(-(10 ** 12), 10 ** 13), 0.5), 10],
  ])();
}

/** A forward step of a clock in ms, mostly small, sometimes minute-sized, sometimes backwards. */
export function clockStep(rng: Rng): number {
  return rng.weighted<() => number>([
    [() => maybeFrac(rng, rng.int(0, 2_000), 0.6), 40],
    [() => maybeFrac(rng, rng.pick([MIN, MIN, MIN - 1, MIN + 1, 2 * MIN, MIN / 2, 30_000]), 0.5), 40],
    [() => maybeFrac(rng, rng.int(0, 10 * MIN), 0.5), 12],
    [() => maybeFrac(rng, -rng.int(1, 3 * MIN), 0.5), 6],
    [() => 0, 2],
  ])();
}

/** A pixel coordinate: mostly small integers, sometimes fractional or huge. */
export function pixel(rng: Rng): number {
  return rng.weighted<() => number>([
    [() => rng.int(-200, 4000), 70],
    [() => maybeFrac(rng, rng.int(-200, 4000), 1) - 0, 14],
    [() => rng.pick([0, 0, 1, -1, 1e-200, 1e150, -1e150, 1e308, 3e307, 2 ** 52, 0.1, 1 / 3]), 10],
    [() => clip(rng.wideInt()), 6],
  ])();
}

/**
 * The output as `JSON.stringify` writes it, read back: `-0` becomes `0` (the
 * recorder refuses `-0`; the JSON text is identical either way) and `NaN` and
 * the infinities become `null`, exactly as the Rust serializer writes them.
 */
export function plain(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value === undefined ? null : value));
}
