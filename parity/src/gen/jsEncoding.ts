/**
 * JSON cannot carry NaN, the infinities or -0. In the `js` fixtures a double is
 * written as a JSON number when that is lossless, and otherwise as one of the
 * strings "NaN", "Infinity", "-Infinity", "-0". The Rust test decodes the same way.
 */
export function enc(x: number): number | string {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  if (Object.is(x, -0)) return '-0';
  return x;
}

export function dec(v: number | string): number {
  if (typeof v === 'number') return v;
  if (v === 'NaN') return NaN;
  if (v === 'Infinity') return Infinity;
  if (v === '-Infinity') return -Infinity;
  if (v === '-0') return -0;
  throw new Error(`bad encoded double ${v}`);
}
