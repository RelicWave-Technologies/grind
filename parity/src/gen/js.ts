import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';
import { REAL_ROWS } from './common';
import { boundaryStrings, randomParseString } from './dates';
import { enc } from './jsEncoding';

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

/** The next double above (`up`) or below `x`. */
function step(x: number, up: boolean): number {
  if (Number.isNaN(x) || (x === Infinity && up) || (x === -Infinity && !up)) return x;
  if (x === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
  view.setFloat64(0, x);
  const big = view.getBigUint64(0);
  const away = (x > 0) === up;
  view.setBigUint64(0, away ? big + 1n : big - 1n);
  return view.getFloat64(0);
}

const SPECIAL: readonly number[] = [
  0, -0, 1, -1, 0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 3.5, -3.5, 33.5, -33.5, 0.1, 0.2, 0.1 + 0.2, 0.3, 1 / 3, -1 / 3, 0.49999999999999994, -0.49999999999999994,
  0.5000000000000001, 4503599627370495.5, -4503599627370495.5, 4503599627370496, 4503599627370497, 9007199254740991, 9007199254740992, -9007199254740992,
  9007199254740993, 1e15, 1e16, 1e20, 1e21, 1.5e21, 1e22, 1e-6, 1e-7, 1.5e-7, 1.234e-7, 123456789012345680000, 12345678901234567, 0.000001, 0.0000011,
  Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE, 2.2250738585072014e-308, 5e-324, Number.EPSILON, NaN, Infinity, -Infinity,
  1791133383891.2627, 1791133448770.0293, 1791133430180.8308, 1791133436609.776, 4.35, 0.145, 1.005, 8.345, 2 ** 31, -(2 ** 31), 2 ** 32, 2 ** 53 + 2, 2 ** 60, 2 ** 63, 2 ** 64, 1 / 7, 100, 1e3, 123.456, 1e100,
];

function interesting(rng: Rng): number {
  return rng.weighted<() => number>([
    [() => rng.pick(SPECIAL), 22],
    [() => randomDouble(rng), 20],
    [() => rng.int(-(10 ** 9), 10 ** 9) + rng.pick([0.5, 0.25, 0.75, 0.1, 0.9, 0.4999999, 0.5000001]), 18],
    [() => step(rng.int(-(10 ** 6), 10 ** 6) + 0.5, rng.chance(0.5)), 10],
    [() => step(rng.pick(SPECIAL), rng.chance(0.5)), 10],
    [() => (rng.next() - 0.5) * 10 ** rng.int(-10, 25), 12],
    [() => rng.pick(REAL_ROWS) + rng.next(), 8],
  ])();
}

function allSpecials(): number[] {
  return [...SPECIAL, ...SPECIAL.flatMap((x) => [step(x, true), step(x, false)])];
}

const unary = (fn: string, f: (x: number) => number): FnSpec<{ x: number }> => ({
  module,
  fn,
  edge: () => allSpecials().map((x) => ({ x })),
  random: (rng) => ({ x: interesting(rng) }),
  call: ({ x }) => f(x),
  record: ({ x }) => ({ x: enc(x) }),
  encodeOutput: (o) => enc(o as number),
  allowNonFinite: true,
});

const binary = (fn: string, f: (a: number, b: number) => number, encodeOut = true): FnSpec<{ a: number; b: number }> => ({
  module,
  fn,
  edge: () => {
    const pool = [0, -0, 1, -1, 0.5, -0.5, 5, -5, 5.5, 3, NaN, Infinity, -Infinity, 1e300, -1e300, 1791133383891.2627, 2 ** 53, 0.1, 0.2];
    return pool.flatMap((a) => pool.map((b) => ({ a, b })));
  },
  random: (rng) => ({ a: interesting(rng), b: interesting(rng) }),
  call: ({ a, b }) => f(a, b),
  record: ({ a, b }) => ({ a: enc(a), b: enc(b) }),
  encodeOutput: encodeOut ? (o) => enc(o as number) : undefined,
  allowNonFinite: true,
});

const SIGN = (n: number): number => (n === 0 || Number.isNaN(n) ? 0 : n > 0 ? 1 : -1);

const STRINGS: readonly string[] = [
  '', 'a', 'A', 'b', 'B', 'z', 'Z', '0', '1', '2', '10', '00', 'ab', 'aB', 'Ab', 'AB', 'a b', 'a-b', 'a_b', 'a.b', ' ', '\t', '\n', '\r', '\u0000', '\u0001', '\u0008', '\u000b', '\u001f', '\u007f',
  '_', '-', ',', ';', ':', '!', '?', '.', "'", '"', '(', ')', '[', ']', '{', '}', '@', '*', '/', '\\', '&', '#', '%', '`', '^', '+', '<', '=', '>', '|', '~', '$',
  'é', 'É', 'é', 'é', 'ä', 'ä', 'ß', 'ss', 'Ω', 'ω', 'Σ', 'σ', 'ς', 'я', 'Я', '中', '日本', '한', '😀', '😀😀', ' ', ' ', '​', 'ǆ', 'ﬁ', 'fi', 'x\u0001y', 'xy',
];

function str(rng: Rng): string {
  return rng.weighted<() => string>([
    [() => rng.pick(STRINGS), 55],
    [() => rng.pick(STRINGS) + rng.pick(STRINGS), 25],
    [() => String.fromCharCode(...Array.from({ length: rng.int(0, 6) }, () => rng.int(0x20, 0x7e))), 20],
  ])();
}

export const specs: FnSpec<any>[] = [
  unary('round', Math.round),
  unary('floor', Math.floor),
  unary('ceil', Math.ceil),
  unary('trunc', Math.trunc),
  binary('max', Math.max),
  binary('min', Math.min),
  binary('rem', (a, b) => a % b),
  binary('add', (a, b) => a + b),
  binary('sub', (a, b) => a - b),
  binary('strictEq', (a, b) => (a === b ? 1 : 0), false),
  binary('sortCmp', (a, b) => SIGN(a - b || 0), false),
  {
    module,
    fn: 'numberToString',
    edge: () => allSpecials().map((x) => ({ x })),
    random: (rng) => ({ x: interesting(rng) }),
    call: ({ x }: { x: number }) => `${x}`,
    record: ({ x }: { x: number }) => ({ x: enc(x) }),
    allowNonFinite: true,
  },
  {
    // JSON.stringify of an array of numbers: non-finite and -0 included.
    module,
    fn: 'jsonStringifyNumbers',
    edge: () => [{ xs: SPECIAL.slice() }, { xs: [] }, { xs: [-0, 0] }, { xs: [NaN, Infinity, -Infinity, 1] }],
    random: (rng) => ({ xs: Array.from({ length: rng.int(1, 6) }, () => interesting(rng)) }),
    call: ({ xs }: { xs: number[] }) => JSON.stringify(xs),
    record: ({ xs }: { xs: number[] }) => ({ xs: xs.map(enc) }),
    allowNonFinite: true,
  },
  {
    module,
    fn: 'jsonQuote',
    edge: () => STRINGS.map((s) => ({ s })).concat([{ s: 'tab\there "q" \\    \u007f \u0000 end' }]),
    random: (rng) => ({ s: str(rng) }),
    call: ({ s }: { s: string }) => JSON.stringify(s),
  },
  {
    module,
    fn: 'localeCompare',
    edge: () => STRINGS.flatMap((a) => STRINGS.map((b) => ({ a, b }))),
    random: (rng) => ({ a: str(rng), b: rng.chance(0.2) ? str(rng) : rng.chance(0.5) ? str(rng) + str(rng) : str(rng) }),
    call: ({ a, b }: { a: string; b: string }) => SIGN(a.localeCompare(b)),
  },
  {
    module,
    fn: 'dateParse',
    edge: () => boundaryStrings().map((s) => ({ s })),
    random: (rng) => ({ s: randomParseString(rng) }),
    call: ({ s }: { s: string }) => new Date(s).getTime(),
    encodeOutput: (o) => enc(o as number),
    allowNonFinite: true,
  },
];

