import type { Rng } from '../prng';
import { MAX_DATE, ts } from './common';

const pad = (n: number, width: number): string => String(Math.abs(n)).padStart(width, '0');

function yearText(year: number): string {
  if (year >= 0 && year <= 9999) return pad(year, 4);
  return `${year < 0 ? '-' : '+'}${pad(year, 6)}`;
}

export interface Parts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millis: number;
}

/** The wall-clock fields of the instant `t` as seen at `offsetMinutes` east of UTC. */
export function partsAt(t: number, offsetMinutes: number): Parts | null {
  const shifted = t + offsetMinutes * 60_000;
  if (Math.abs(shifted) > MAX_DATE) return null;
  const d = new Date(shifted);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    millis: d.getUTCMilliseconds(),
  };
}

export function offsetText(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  return `${sign}${pad(Math.floor(Math.abs(minutes) / 60), 2)}:${pad(Math.abs(minutes) % 60, 2)}`;
}

export type TimeStyle = 'full' | 'noMillis' | 'noSeconds' | 'frac1' | 'frac2' | 'frac6' | 'frac9';

export function timeText(p: Parts, style: TimeStyle): string {
  const hm = `${pad(p.hour, 2)}:${pad(p.minute, 2)}`;
  const s = pad(p.second, 2);
  const ms = pad(p.millis, 3);
  switch (style) {
    case 'noSeconds': return hm;
    case 'noMillis': return `${hm}:${s}`;
    case 'frac1': return `${hm}:${s}.${ms.slice(0, 1)}`;
    case 'frac2': return `${hm}:${s}.${ms.slice(0, 2)}`;
    case 'frac6': return `${hm}:${s}.${ms}${pad(0, 3)}`;
    case 'frac9': return `${hm}:${s}.${ms}999999`;
    default: return `${hm}:${s}.${ms}`;
  }
}

/** The instant `t` as an ISO string with the given offset (`null` = `Z`). */
export function iso(t: number, offsetMinutes: number | null, style: TimeStyle = 'full'): string | null {
  const minutes = offsetMinutes ?? 0;
  const p = partsAt(t, minutes);
  if (!p) return null;
  const zone = offsetMinutes === null ? 'Z' : offsetText(offsetMinutes);
  return `${yearText(p.year)}-${pad(p.month, 2)}-${pad(p.day, 2)}T${timeText(p, style)}${zone}`;
}

export const OFFSETS: readonly (number | null)[] = [
  null, null, null, 0, 330, -300, 60, -60, 840, -720, 1439, -1439, 345, 570, -210, 765,
];

const STYLES: readonly TimeStyle[] = ['full', 'full', 'full', 'noMillis', 'noSeconds', 'frac1', 'frac2', 'frac6', 'frac9'];

/** Strings of every supported shape for the instant `t` (some are lossy). */
export function validString(rng: Rng, t: number): string | null {
  const offset = rng.pick(OFFSETS);
  const style = rng.pick(STYLES);
  const form = rng.weighted<'full' | 'dateOnly' | 'monthOnly' | 'yearOnly' | 'monthT' | 'yearT'>([
    ['full', 70], ['dateOnly', 10], ['monthOnly', 4], ['yearOnly', 4], ['monthT', 6], ['yearT', 6],
  ]);
  const p = partsAt(t, offset ?? 0);
  if (!p) return null;
  const zone = offset === null ? 'Z' : offsetText(offset);
  const y = yearText(p.year);
  const mo = pad(p.month, 2);
  const d = pad(p.day, 2);
  const time = `T${timeText(p, style)}${zone}`;
  switch (form) {
    case 'dateOnly': return `${y}-${mo}-${d}`;
    case 'monthOnly': return `${y}-${mo}`;
    case 'yearOnly': return y;
    case 'monthT': return `${y}-${mo}${time}`;
    case 'yearT': return `${y}${time}`;
    default: return `${y}-${mo}-${d}${time}`;
  }
}

/**
 * ISO-shaped strings with one field out of range, or on a boundary V8 treats
 * specially (Feb 30, hour 24, `-000000`, the Date limits, leap seconds).
 */
export function boundaryStrings(): string[] {
  const out: string[] = [];
  const dates = ['2024-01-15', '2024-02-29', '2023-02-29', '2024-02-30', '2023-02-31', '2024-04-31', '2024-06-31', '2024-12-31', '2024-00-10', '2024-13-10', '2024-01-00', '2024-01-32', '2024-02-32', '0000-01-01', '9999-12-31'];
  const times = [
    '00:00:00.000Z', '23:59:59.999Z', '24:00:00.000Z', '24:00:00Z', '24:00Z', '24:00:00.0Z', '24:00:00.00Z', '24:00:00.0001Z', '24:00:01Z', '24:01Z', '25:00:00Z',
    '00:60:00Z', '00:00:60Z', '23:59:60Z', '12:30:15.5Z', '12:30:15.05Z', '12:30:15.0005Z', '12:30:15.123456789Z', '12:30:15.9999999Z',
    '12:30:15+05:30', '12:30:15-05:30', '12:30:15+00:00', '12:30:15-00:00', '12:30:15+14:00', '12:30:15+23:59', '12:30:15-23:59', '12:30:15+24:00', '12:30:15+05:60', '12:30:15+99:99',
    '24:00:00+01:00', '24:00:00-01:00', '00:00+05:30', '00:00-05:30',
  ];
  for (const d of dates) for (const t of times) out.push(`${d}T${t}`);
  out.push(
    '2024', '2024-06', '2024-06-15', '0000', '9999', '0000-01', '2024-00', '2024-13', '2024-02-30', '2024-02-31', '2024-04-31',
    '+002024-06-15', '+002024', '+002024-06', '-000001-06-15', '-000001', '-000000', '-000000-01-01', '-000000-01-01T00:00:00Z', '+000000', '+000000-06-15',
    '+275760-09-13', '+275760-09-13T00:00:00.000Z', '+275760-09-13T00:00:00.001Z', '+275760-09-14', '+275760-09-13T00:00:00.000+00:01', '+275760-09-12T23:59:59.999-00:01',
    '+275760-09-13T00:00:00.000-00:01', '+275760-09-12T23:59:59.999Z', '+275761-01-01T00:00:00Z', '+999999-12-31T23:59:59.999Z',
    '-271821-04-20', '-271821-04-20T00:00:00.000Z', '-271821-04-19T23:59:59.999Z', '-271821-04-20T00:00:00.000+00:01', '-271821-04-20T00:00:00.000-00:01',
    '-271821-04-19', '-271822-01-01T00:00:00Z', '-999999-01-01T00:00:00Z',
    '1970-01-01T00:00:00.000Z', '1969-12-31T23:59:59.999Z', '1970-01-01T00:00:00.000+00:00',
    '2024T00:00Z', '2024-06T00:00Z', '2024T24:00Z', '2024-06T24:00:00.000+01:00',
    '2024-03-10T01:59:59-05:00', '2024-03-10T03:00:00-04:00', '2024-11-03T01:30:00-04:00', '2024-11-03T01:30:00-05:00', '2024-06-15T00:00:00+05:30',
  );
  return out;
}

const two = (n: number): string => String(n).padStart(2, '0');

/** A string of a supported shape whose fields are random and may be out of range. */
function shapedWithRandomFields(rng: Rng): string {
  const year = rng.weighted<string>([
    [String(rng.int(0, 9999)).padStart(4, '0'), 70],
    [`+${String(rng.int(0, 999999)).padStart(6, '0')}`, 12],
    [`-${String(rng.pick([0, 1, 271821, 271822, rng.int(0, 999999)])).padStart(6, '0')}`, 12],
    [rng.pick(['1970', '2024', '0000', '9999', '2000']), 6],
  ]);
  const month = rng.chance(0.85) ? rng.int(1, 12) : rng.pick([0, 13, 14, 99]);
  const day = rng.chance(0.8) ? rng.int(1, 28) : rng.pick([0, 29, 30, 31, 32, 33, 99]);
  const date = rng.weighted<string>([[`${year}-${two(month)}-${two(day)}`, 70], [`${year}-${two(month)}`, 12], [year, 8], [`${year}-${two(month)}-${two(day)}`, 10]]);
  if (rng.chance(0.3)) return date;
  const hour = rng.chance(0.85) ? rng.int(0, 23) : rng.pick([24, 24, 25, 99]);
  const minute = rng.chance(0.9) ? rng.int(0, 59) : rng.pick([60, 61, 99]);
  const second = rng.chance(0.9) ? rng.int(0, 59) : rng.pick([60, 61, 99]);
  const fraction = rng.weighted<string>([['', 30], ['.000', 15], [`.${String(rng.int(0, 999)).padStart(3, '0')}`, 25], ['.5', 6], ['.0', 4], ['.00', 3], ['.0001', 3], ['.123456789', 6], ['.0000000000', 2]]);
  const zone = rng.weighted<string>([
    ['Z', 40],
    [`${rng.pick(['+', '-'])}${two(rng.int(0, 23))}:${two(rng.pick([0, 15, 30, 45, rng.int(0, 59)]))}`, 40],
    [`${rng.pick(['+', '-'])}${two(rng.pick([24, 25, 99]))}:${two(rng.int(0, 59))}`, 8],
    [`${rng.pick(['+', '-'])}${two(rng.int(0, 23))}:${two(rng.pick([60, 61, 99]))}`, 8],
    ['+00:00', 2], ['-00:00', 2],
  ]);
  const clock = rng.chance(0.12) ? `${two(hour)}:${two(minute)}` : `${two(hour)}:${two(minute)}:${two(second)}${fraction}`;
  return `${date}T${clock}${zone}`;
}

/** A supported-shape string for `Date.parse`: valid, boundary, or with a bad field. */
export function randomParseString(rng: Rng): string {
  return rng.weighted<() => string>([
    [() => validString(rng, ts(rng)) ?? '2024', 40],
    [() => shapedWithRandomFields(rng), 45],
    [() => rng.pick(boundaryStrings()), 15],
  ])();
}
