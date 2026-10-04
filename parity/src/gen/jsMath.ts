import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';
import { enc } from './jsEncoding';
import { MAX_DATE } from './common';

const module = 'js';

const view = new DataView(new ArrayBuffer(8));

/** A uniformly random finite double (random bits), so every exponent is hit. */
function randomDouble(rng: Rng): number {
  for (;;) {
    view.setUint32(0, Math.floor(rng.next() * 2 ** 32));
    view.setUint32(4, Math.floor(rng.next() * 2 ** 32));
    const x = view.getFloat64(0);
    if (Number.isFinite(x)) return x;
  }
}

/** The double next to `x`, `n` steps away in magnitude. */
function nudge(x: number, n: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  view.setFloat64(0, x);
  view.setBigUint64(0, view.getBigUint64(0) + BigInt(n));
  return view.getFloat64(0);
}

const SPECIAL = [0, -0, 1, -1, 3, 4, 5, 12, 0.1, 0.2, 0.5, 1e-200, -1e-200, 1e150, -1e150, 1e154, 1e155, 1e307, 1e308, Number.MAX_VALUE, Number.MIN_VALUE, 2.2250738585072014e-308, 1791133383891.2627, 2 ** 53, 7, 0.3, 1 / 3, Infinity, -Infinity, NaN];

/** Pixel-like numbers mostly, sometimes anything. */
function value(rng: Rng): number {
  return rng.weighted<() => number>([
    [() => rng.int(-4000, 4000), 36],
    [() => rng.int(-4000, 4000) + rng.pick([0.5, 0.25, 0.1, 0.75, 1 / 3]), 14],
    [() => rng.pick(SPECIAL), 14],
    [() => randomDouble(rng), 14],
    [() => (rng.next() - 0.5) * 10 ** rng.int(-30, 30), 14],
    [() => nudge(rng.int(1, 5000), rng.int(-3, 3)), 8],
  ])();
}

const binary = (fn: string, f: (a: number, b: number) => number): FnSpec<{ a: number; b: number }> => ({
  module,
  fn,
  edge: () => SPECIAL.flatMap((a) => SPECIAL.map((b) => ({ a, b }))),
  random: (rng) => ({ a: value(rng), b: value(rng) }),
  call: ({ a, b }) => f(a, b),
  record: ({ a, b }) => ({ a: enc(a), b: enc(b) }),
  encodeOutput: (o) => enc(o as number),
  allowNonFinite: true,
});

const unary = (fn: string, f: (x: number) => number): FnSpec<{ x: number }> => ({
  module,
  fn,
  edge: () => SPECIAL.map((x) => ({ x })),
  random: (rng) => ({ x: value(rng) }),
  call: ({ x }) => f(x),
  record: ({ x }) => ({ x: enc(x) }),
  encodeOutput: (o) => enc(o as number),
  allowNonFinite: true,
});

const hypotN: FnSpec<{ xs: Array<number | string> }> = {
  module,
  fn: 'hypotN',
  edge: () => [{ xs: [] }, { xs: [3] }, { xs: [3, 4] }, { xs: [3, 4, 12] }, { xs: [0, 0, 0] }, { xs: [enc(NaN), enc(Infinity)] }, { xs: [enc(NaN), 3] }, { xs: [enc(-Infinity), 3, enc(NaN)] }],
  random: (rng) => ({ xs: Array.from({ length: rng.weighted([[2, 55], [3, 20], [1, 8], [4, 10], [5, 7]] as const) }, () => enc(value(rng))) }),
  call: ({ xs }) => Math.hypot(...xs.map((x) => (typeof x === 'number' ? x : { NaN, Infinity, '-Infinity': -Infinity, '-0': -0 }[x] ?? NaN))),
  record: (i) => i,
  encodeOutput: (o) => enc(o as number),
  allowNonFinite: true,
};

const isoSpec: FnSpec<{ ms: number }> = {
  module,
  fn: 'toIsoString',
  edge: () => [0, 1, -1, 999, 1000, 1700000000000, 1791133383891.2627, -1.5, 1.9, MAX_DATE, -MAX_DATE, MAX_DATE + 1, -MAX_DATE - 1, 253402300799999, 253402300800000, -62198755200000, -62198755200001, 951782400000, 4107542400000, -2208988800000, 0.9999999, -0.9999999].map((ms) => ({ ms })),
  random: (rng) => ({
    ms: rng.weighted<number>([
      [rng.int(-(10 ** 13), 10 ** 13) + rng.pick([0, 0.5, 0.25, 0.999]), 50],
      [(rng.next() - 0.5) * 2 * MAX_DATE, 20],
      [rng.pick([MAX_DATE, -MAX_DATE, MAX_DATE + 1, -MAX_DATE - 1, 253402300799999, 253402300800000, -62198755200000, -62198755200001]) + rng.int(-3, 3), 20],
      [rng.int(-(10 ** 11), 10 ** 12) + rng.next(), 10],
    ]),
  }),
  call: ({ ms }) => new Date(ms).toISOString(),
};

const TRIM = ['', ' ', 'a', ' a ', ' x ', '﻿x﻿', '\u0085x\u0085', '᠎x᠎', '​x​', ' x ', '\t\n\v\f\r x', '              　y', 'é ', ' 😀 ', '\u0085', '﻿'];
const trimSpec: FnSpec<{ text: string }> = {
  module,
  fn: 'trim',
  edge: () => TRIM.map((text) => ({ text })),
  random: (rng) => ({ text: Array.from({ length: rng.int(1, 5) }, () => rng.pick(TRIM)).join(rng.pick(['', 'a'])) }),
  call: ({ text }) => text.trim(),
};

export const specs: FnSpec<any>[] = [
  binary('mul', (a, b) => a * b),
  binary('div', (a, b) => a / b),
  binary('hypot', (a, b) => Math.hypot(a, b)),
  unary('sqrt', (x) => Math.sqrt(x)),
  unary('square', (x) => x ** 2),
  unary('abs', (x) => Math.abs(x)),
  hypotN,
  isoSpec,
  trimSpec,
];
