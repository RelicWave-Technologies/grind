import type { Rng } from '../prng';
import { REAL_ROWS, T0, MIN, id as anyId, maybeFrac } from './common';

/** Strings the persistence layer must carry byte for byte: quotes, backslashes, newlines, emoji, combining marks, CJK. */
const TEXTS = [
  '', ' ', 'a', 'Safari', 'Visual Studio Code', 'com.apple.Safari', 'é', 'e\u0301', '日本語のタイトル', '😀 launch 🚀', 'a\u2028b', 'tab\there', 'line\nbreak', 'CRLF\r\n',
  "O'Reilly", '"quoted"', 'back\\slash', '--; DROP TABLE x', '%_', 'https://example.com/a?b=c&d=%20#frag', 'C:\\Users\\a\\file.png', '/tmp/timo/2026-01-02/01HZXYZ.webp',
  'x'.repeat(300), '\u0001\u001f', '\u007f', 'ÿ', '\ud83d\ude00',
];

export function text(rng: Rng): string {
  return rng.weighted<() => string>([
    [() => rng.pick(TEXTS), 70],
    [() => anyId(rng), 20],
    [() => Array.from({ length: rng.int(1, 12) }, () => String.fromCodePoint(rng.pick([rng.int(32, 126), rng.int(160, 0x7ff), rng.int(0x4e00, 0x4e50), rng.int(0x1f600, 0x1f64f)]))).join(''), 10],
  ])();
}

/** A string or `null`. */
export function maybeText(rng: Rng, nullChance = 0.3): string | null {
  return rng.chance(nullChance) ? null : text(rng);
}

/** A non-negative count: mostly small whole numbers, sometimes fractional, huge, or awkward. */
export function count(rng: Rng): number {
  return rng.weighted<() => number>([
    [() => rng.int(0, 300), 55],
    [() => rng.pick([0, 0, 1, 5, 6, 59, 60, 61, 255, 256, 65535, 2 ** 31 - 1, 2 ** 31, 2 ** 32, 2 ** 40, 2 ** 53, 1e15, 1e19, 1e300, 5e-324]), 17],
    [() => maybeFrac(rng, rng.int(0, 5000), 1), 18],
    [() => -rng.int(1, 1000), 5],
    [() => rng.pick([0.1, 0.2, 0.5, 1 / 3, 2.5, 1e-7, 1.7976931348623157e308, 4611686018427387904, 9223372036854775807, -9223372036854775808]), 5],
  ])();
}

/** A REAL-column value: a coefficient of variation, or occasionally an integer or odd double. */
export function ratio(rng: Rng): number {
  return rng.weighted<() => number>([
    [() => rng.next(), 50],
    [() => rng.pick([0, 1, 0.5, 2, 0.1 + 0.2, 1e-9, 1e300, 1 / 3, 1.0000000000000002]), 30],
    [() => rng.int(0, 400) / 100, 20],
  ])();
}

/** A minute-aligned bucket start (whole, usually), sometimes fractional like the server-aligned clock. */
export function bucket(rng: Rng): number {
  const minute = Math.floor((T0 + rng.int(-3000, 3000) * MIN) / MIN) * MIN;
  return rng.weighted<() => number>([
    [() => minute, 70],
    [() => maybeFrac(rng, minute, 1), 15],
    [() => rng.pick(REAL_ROWS), 5],
    [() => rng.pick([0, 1, -1, 2 ** 53, 1e300]), 5],
    [() => count(rng), 5],
  ])();
}

/** A pre-seeded SQL list chosen by `weights`. */
export function sample<T>(rng: Rng, items: readonly T[], n: number): T[] {
  return Array.from({ length: n }, () => rng.pick(items));
}
