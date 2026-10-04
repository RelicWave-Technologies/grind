import {
  TimeZoneSchema,
  dateKeyInTimeZone,
  instantForZonedDateTime,
  isValidTimeZone,
  localDayWindowInTimeZone,
  medianMinute,
  possibleInstantsForZonedDateTime,
  zonedDateTimeParts,
  type ZonedDateTimeParts,
} from '@grind/types';
import type { Rng } from '../prng';
import type { FnSpec } from '../fixture';
import { OFFSET_DRIFT, VALIDITY_DRIFT, ZONE_IDS } from './tzIds';
import {
  DENSE_ZONES,
  FROM_2015,
  MS_PER_DAY,
  MS_PER_HOUR,
  TO_2036,
  denseTransitions,
  offsetTransitions,
  type Transition,
} from './tzZones';

/**
 * Golden output for `packages/types/src/timezone.ts` (business-day maths).
 *
 * The oracle is `Intl`, so the numbers are only as good as the runtime's ICU:
 * Electron 33.2.0 ships ICU 74.2 / tzdata 2024a, this harness runs on whatever
 * Node is installed (see PARITY.md). Every zone and instant a runtime could
 * disagree about is left out of these fixtures (`OFFSET_DRIFT`,
 * `VALIDITY_DRIFT`); `PARITY_FIXTURE_ROOT=... pnpm fixtures` under Electron
 * (`ELECTRON_RUN_AS_NODE=1`) must reproduce them byte for byte.
 */

const keep = (id: string): boolean => !VALIDITY_DRIFT.includes(id) && !OFFSET_DRIFT.includes(id);
const FIXTURE_IDS = ZONE_IDS.filter(keep);

// ---------------------------------------------------------------------------
// Time zone ids
// ---------------------------------------------------------------------------

/** Strings `Intl` must reject (or, for the odd ones, accept): all decided by the engine, not by us. */
const HAND_PICKED_IDS: readonly string[] = [
  '', ' ', 'a', 'Z', 'z', 'UTC', 'utc', 'Utc', 'uTc', 'GMT', 'gmt', 'Etc/UTC', 'ETC/UTC', 'Etc/GMT', 'Etc/GMT0', 'Etc/GMT+0', 'Etc/GMT-0',
  'GMT0', 'GMT+0', 'GMT-0', 'Greenwich', 'Universal', 'Zulu', 'UCT', 'Etc/GMT+5', 'Etc/GMT-14', 'Etc/GMT+12', 'Etc/GMT+13', 'Etc/GMT-15',
  'Etc/GMT+01', 'Etc/GMT+1', 'Etc/GMT-1', 'GMT+1', 'GMT+01', 'GMT+5', 'UTC+5', 'UTC+05:00', 'UTC+05:30', 'GMT+05:00', 'Etc/Unknown', 'Etc/Foo',
  'localtime', 'posixrules', 'Factory'.toLowerCase() + 'x', 'US/Eastern', 'us/eastern', 'US/EASTERN', 'america/new_york', 'AMERICA/NEW_YORK',
  'America/New_York ', ' America/New_York', 'America/New_York\n', '\tAmerica/New_York', 'America/New_York\u0000', 'America/New_York/', '/America/New_York',
  'America//New_York', 'America\\New_York', 'America/New York', 'America/New-York', 'America/NewYork', 'America/New_Yor', 'America/New_Yorkk',
  'Asia/Kolkata', 'asia/kolkata', 'ASIA/KOLKATA', 'Asia/Calcutta', 'Asia/Kolkata ', ' Asia/Kolkata', 'Asia/Kolkata', 'Asia/Kolkata​',
  'Asia/Kathmandu', 'Asia/Katmandu', 'Europe/Kyiv', 'Europe/Kiev', 'Pacific/Kanton', 'Pacific/Enderbury', 'Asia/Ho_Chi_Minh', 'Asia/Saigon', 'America/Nuuk',
  'America/Godthab', 'America/Coyhaique'.replace('Coyhaique', 'Coyhaiqu'), 'İstanbul', 'Europe/İstanbul', 'Europe/Istanbul', 'Ｕ', 'ＵＴＣ', 'UTC﻿',
  'Mars/Olympus', 'Asia', 'Asia/', '/', '//', 'Europe/London/', 'Europe', 'Europe/london', 'EUROPE/LONDON', 'europe/LONDON', 'Zulu ', ' Zulu',
  'EST', 'MST', 'HST', 'EST5EDT', 'CST6CDT', 'MST7MDT', 'PST8PDT', 'CET', 'MET', 'EET', 'WET', 'est', 'Est', 'ist', 'IST', 'PST', 'pst', 'CST', 'BST', 'bst',
  'SystemV/EST5', 'systemv/est5', 'SystemV/EST5EDT', 'SystemV/PST8PDT', 'SystemV/YST9', 'SystemV/AST4ADT', 'SystemV/AST4', 'SystemV/FOO5', 'SystemV',
  'Canada/East-Saskatchewan', 'US/Pacific-New', 'US/Pacific', 'null', 'undefined', 'NaN', '0', '1', '-', '+', '+:', '::', '..', '../etc/passwd', 'UTC;', 'UTC,',
  '😀', 'Europe/París', 'Europe/Paris', 'Africa/Abidjan'.toUpperCase(), 'Africa/ABIDJAN', 'a'.repeat(80), 'a'.repeat(81), 'Europe/'.padEnd(200, 'x'),
];

const OFFSET_IDS: readonly string[] = [
  '+00', '-00', '+0000', '-0000', '+00:00', '-00:00', '−00:00', '+01', '+0100', '+01:00', '-01', '-0100', '-01:00', '−01:00',
  '+05', '+0530', '+05:30', '-0530', '-05:30', '−05:30', '+0545', '+05:45', '-0930', '-09:30', '+1245', '+12:45', '+14', '+1400', '+14:00',
  '+15', '+18', '+18:00', '+22', '+2300', '+23:00', '+23', '+2359', '+23:59', '-23:59', '-2359', '+24', '+2400', '+24:00', '+99', '+9999',
  '+5', '+5:30', '+05:3', '+053', '+05:60', '+0560', '+0600', '+06:00', '+05:30:00', '+05:30:15', '+053015', '05:30', '0530', '+05 30', '++05:30',
  '+-05:30', '+05:30 ', ' +05:30', '+05:30\n', '+05.30', '+05;30', '+05-30', '+5:3', '+', '-', '+:', '+0', '+00:0', '+00::00', '+000', '+00000',
  '−', '−05', '−0530', 'UTC+05:30', 'GMT+05:30', 'Z+05:30', '+05:30Z', '+٥٠:٣٠', '+０５:３０',
  '+0̵', '–' + '05:30', '—' + '05:30',
];

const pad2 = (n: number): string => String(n).padStart(2, '0');

function randomOffsetId(rng: Rng): string {
  const sign = rng.pick(['+', '-', '−']);
  const hours = pad2(rng.int(0, 27));
  const minutes = pad2(rng.int(0, 64));
  switch (rng.int(0, 3)) {
    case 0: return `${sign}${hours}`;
    case 1: return `${sign}${hours}${minutes}`;
    case 2: return `${sign}${hours}:${minutes}`;
    default: return `${sign}${hours}:${minutes}${rng.chance(0.3) ? ':00' : ''}`;
  }
}

function mixedCase(rng: Rng, id: string): string {
  return [...id].map((c) => (rng.chance(0.5) ? c.toUpperCase() : c.toLowerCase())).join('');
}

function mutate(rng: Rng, id: string): string {
  const at = rng.int(0, Math.max(0, id.length - 1));
  switch (rng.int(0, 7)) {
    case 0: return id.slice(0, at) + id.slice(at + 1);
    case 1: return id.slice(0, at) + rng.pick(['x', '_', '/', ' ', '0', '-', '+', 'é', '\u0000']) + id.slice(at);
    case 2: return id + rng.pick([' ', '\n', '/', '_', '0', 'x']);
    case 3: return rng.pick([' ', '\t', ' ']) + id;
    case 4: return id.replace('/', rng.pick(['\\', '//', ':', '.', '-']));
    case 5: return id.slice(0, at);
    case 6: return id.slice(at);
    default: return id.slice(0, at) + id.charAt(at).toUpperCase() + id.slice(at + 1);
  }
}

/** A zone id for an input that is usually valid but sometimes not. */
function anyZoneId(rng: Rng): string {
  return rng.weighted<() => string>([
    [() => rng.pick(DENSE_ZONES), 80],
    [() => rng.pick(FIXTURE_IDS), 12],
    [() => rng.pick(HAND_PICKED_IDS), 5],
    [() => randomOffsetId(rng), 3],
  ])();
}

const INVALID_ZONES: readonly string[] = ['', 'Mars/Olympus', 'UTC ', ' UTC', 'Z', 'UTC+5', 'Asia/Kolkata\n', 'Etc/GMT+13', '+24:00', '+5:30'];

// ---------------------------------------------------------------------------
// Instants and wall clocks
// ---------------------------------------------------------------------------

const wallParts = (wallMs: number): ZonedDateTimeParts => {
  const d = new Date(wallMs);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
};
const dateText = (p: { year: number; month: number; day: number }): string => `${String(p.year).padStart(4, '0')}-${pad2(p.month)}-${pad2(p.day)}`;

/** Instants worth reading in a zone around one offset change. */
const aroundInstants = (t: Transition): number[] => [t.at - 1, t.at, t.at - MS_PER_HOUR, t.at + MS_PER_HOUR];

/** The wall-clock readings that straddle a change: the gap or the repeated hour. */
function aroundWalls(t: Transition): ZonedDateTimeParts[] {
  const first = t.at + t.before;
  const second = t.at + t.after;
  const low = Math.min(first, second);
  const high = Math.max(first, second);
  return [low - 1000, low, high - 1000, high].map(wallParts);
}

/** Dates whose midnight sits next to a change. */
function aroundDates(t: Transition): string[] {
  const days = [t.at + t.before, t.at + t.after].flatMap((w) => [w - MS_PER_DAY, w, w + MS_PER_DAY]);
  return days.map((w) => dateText(wallParts(w)));
}

let transitionCache: Transition[] | null = null;
const transitions = (): Transition[] => (transitionCache ??= denseTransitions());

function randomInstant(rng: Rng): number {
  const uniform = (lo: number, hi: number): number => lo + Math.floor(rng.next() * (hi - lo));
  return rng.weighted<() => number>([
    [() => uniform(FROM_2015, TO_2036), 62],
    [() => uniform(FROM_2015, TO_2036) + rng.pick([0.25, 0.5, 0.999, 0.001]), 8],
    [() => uniform(FROM_2015, TO_2036) - (uniform(FROM_2015, TO_2036) % 3_600_000), 14],
    [() => uniform(Date.UTC(1970, 0, 1), Date.UTC(2100, 0, 1)), 12],
    [() => rng.pick([0, 1, -1, 2 ** 31, 2 ** 32, 1e12, Date.UTC(2038, 0, 19, 3, 14, 7), Date.UTC(2037, 11, 31, 23, 59, 59)]), 4],
  ])();
}

/** Instants at the edges of what a `Date` (and the Gregorian calendar) can hold. */
const WIDE_INSTANTS: readonly number[] = [
  8.64e15, 8.64e15 - 1, 8.64e15 + 1, -8.64e15, -8.64e15 + 1, -8.64e15 - 1, 1e16, -1e16, 253402300799999, 253402300800000, 253402300800001,
  -62135596800000, -62135596800001, -62167219200000, -62167219200001, -62198755200000, -62230291200000, -2208988800000, -2208988800001,
  -2177452800000, -3155760000000, -12219292800000, -12219292800001, -11676096000000, -30610224000000, 4102444800000, 4133980800000,
  7258118400000, 32503680000000, 1e14, -1e14, 1e13, -1e13, 1e15, -1e15, 5e15, -5e15, -0.5, 0.5, -1.5, 1.5, 2 ** 52,
];
const WIDE_ZONES: readonly string[] = ['UTC', 'Asia/Kolkata', 'America/New_York', 'Europe/London', 'Australia/Lord_Howe', 'Pacific/Apia', 'America/Sao_Paulo', 'Pacific/Chatham'];

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

interface ValueIn { value: number; timeZone: string }
interface PartsIn { parts: ZonedDateTimeParts; timeZone: string }
interface DateIn { date: string; timeZone: string }

function valueEdge(): ValueIn[] {
  const cases: ValueIn[] = [];
  for (const t of transitions()) for (const value of aroundInstants(t)) cases.push({ value, timeZone: t.zone });
  for (const zone of INVALID_ZONES) cases.push({ value: 0, timeZone: zone }, { value: Number.MAX_SAFE_INTEGER, timeZone: zone });
  for (const value of [0, 1, -1, 0.5, -0.5, 1.9, -1.9, 1e16, -1e16, 8.64e15, -8.64e15, 8.64e15 + 1]) {
    for (const timeZone of ['UTC', 'Asia/Kolkata', 'America/New_York']) cases.push({ value, timeZone });
  }
  return cases;
}

function valueRandom(rng: Rng): ValueIn {
  return { value: randomInstant(rng), timeZone: anyZoneId(rng) };
}

const BAD_PARTS: readonly ZonedDateTimeParts[] = [
  { year: 2024, month: 0, day: 1, hour: 0, minute: 0, second: 0 }, { year: 2024, month: 13, day: 1, hour: 0, minute: 0, second: 0 },
  { year: 2024, month: 1, day: 0, hour: 0, minute: 0, second: 0 }, { year: 2024, month: 1, day: 32, hour: 0, minute: 0, second: 0 },
  { year: 2024, month: 4, day: 31, hour: 0, minute: 0, second: 0 }, { year: 2023, month: 2, day: 29, hour: 0, minute: 0, second: 0 },
  { year: 2024, month: 2, day: 29, hour: 0, minute: 0, second: 0 }, { year: 2100, month: 2, day: 29, hour: 0, minute: 0, second: 0 },
  { year: 2000, month: 2, day: 29, hour: 12, minute: 0, second: 0 }, { year: 2024, month: 1, day: 1, hour: 24, minute: 0, second: 0 },
  { year: 2024, month: 1, day: 1, hour: -1, minute: 0, second: 0 }, { year: 2024, month: 1, day: 1, hour: 0, minute: 60, second: 0 },
  { year: 2024, month: 1, day: 1, hour: 0, minute: -1, second: 0 }, { year: 2024, month: 1, day: 1, hour: 0, minute: 0, second: 60 },
  { year: 2024, month: 1, day: 1, hour: 0, minute: 0, second: -1 }, { year: 0, month: 1, day: 1, hour: 0, minute: 0, second: 0 },
  { year: 50, month: 6, day: 15, hour: 12, minute: 0, second: 0 }, { year: 99, month: 12, day: 31, hour: 23, minute: 59, second: 59 },
  { year: 100, month: 1, day: 1, hour: 0, minute: 0, second: 0 }, { year: 1, month: 1, day: 1, hour: 0, minute: 0, second: 0 },
  { year: -1, month: 1, day: 1, hour: 0, minute: 0, second: 0 }, { year: 1900, month: 1, day: 1, hour: 0, minute: 0, second: 0 },
  { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 }, { year: 9999, month: 12, day: 31, hour: 23, minute: 59, second: 59 },
  { year: 10000, month: 1, day: 1, hour: 0, minute: 0, second: 0 }, { year: 275760, month: 9, day: 13, hour: 0, minute: 0, second: 0 },
  { year: 275760, month: 9, day: 12, hour: 23, minute: 59, second: 59 }, { year: 275760, month: 9, day: 13, hour: 0, minute: 0, second: 1 },
  { year: -271821, month: 4, day: 20, hour: 0, minute: 0, second: 0 }, { year: -271821, month: 4, day: 19, hour: 23, minute: 59, second: 59 },
  { year: 1_000_000, month: 1, day: 1, hour: 0, minute: 0, second: 0 }, { year: 2024, month: 6, day: 15, hour: 12, minute: 30, second: 45 },
];

function partsEdge(): PartsIn[] {
  const cases: PartsIn[] = [];
  for (const t of transitions()) for (const parts of aroundWalls(t)) cases.push({ parts, timeZone: t.zone });
  for (const parts of BAD_PARTS) for (const timeZone of ['UTC', 'Asia/Kolkata', 'America/New_York']) cases.push({ parts, timeZone });
  for (const timeZone of INVALID_ZONES) cases.push({ parts: BAD_PARTS[BAD_PARTS.length - 1]!, timeZone });
  return cases;
}

function partsRandom(rng: Rng): PartsIn {
  const timeZone = anyZoneId(rng);
  if (rng.chance(0.12)) {
    const parts = {
      year: rng.pick([2024, 2025, 2026, 1999, 100, 99, 0, -5, 275760, 9999, 10000]),
      month: rng.pick([0, 1, 2, 3, 6, 12, 13, -1]),
      day: rng.pick([0, 1, 15, 28, 29, 30, 31, 32]),
      hour: rng.pick([-1, 0, 1, 2, 12, 23, 24]),
      minute: rng.pick([-1, 0, 30, 59, 60]),
      second: rng.pick([-1, 0, 59, 60]),
    };
    return { parts, timeZone };
  }
  const wall = rng.chance(0.8) ? FROM_2015 + Math.floor(rng.next() * (TO_2036 - FROM_2015)) : randomInstant(rng);
  return { parts: wallParts(Math.floor(wall / 1000) * 1000), timeZone };
}

const BAD_DATES: readonly string[] = [
  '', '2024', '2024-01', '20240101', '2024-1-1', '24-01-01', '2024-01-1', '2024-01-01 ', ' 2024-01-01', '2024-01-01\n', '2024-01-01T00:00:00',
  '2024-01-01Z', '2024/01/01', '2024.01.01', '２０２４-01-01', '٢٠٢٤-01-01', '2024-02-30', '2024-02-29', '2023-02-29', '2024-04-31',
  '2024-13-01', '2024-00-10', '2024-01-00', '2024-01-32', '0000-01-01', '0001-01-01', '0050-06-15', '0099-12-31', '0100-01-01', '0100-02-29', '1900-01-01',
  '9999-12-31', '9999-12-30', '0000-00-00', '-001-01-01', '2024-+1-01', '2024-01-+1', '2024-0x-01', '2024-01-01\u0000', '2038-01-19', '2000-02-29',
];

function dateEdge(): DateIn[] {
  const cases: DateIn[] = [];
  const seen = new Set<string>();
  for (const t of transitions()) {
    for (const date of aroundDates(t)) {
      if (seen.has(`${t.zone}|${date}`)) continue;
      seen.add(`${t.zone}|${date}`);
      cases.push({ date, timeZone: t.zone });
    }
  }
  for (const date of BAD_DATES) for (const timeZone of ['UTC', 'Asia/Kolkata', 'America/Sao_Paulo']) cases.push({ date, timeZone });
  for (const timeZone of INVALID_ZONES) cases.push({ date: '2024-06-15', timeZone });
  return cases;
}

function dateRandom(rng: Rng): DateIn {
  const timeZone = anyZoneId(rng);
  if (rng.chance(0.08)) return { date: rng.pick(BAD_DATES), timeZone };
  const date = dateText(wallParts(randomInstant(rng)));
  return { date, timeZone };
}

const millis = (d: Date): number => d.getTime();

// ---------------------------------------------------------------------------
// isValidTimeZone / TimeZoneSchema
// ---------------------------------------------------------------------------

interface IdIn { id: string }
const ID_PREFIX = ['', ' ', '\t', '\n', ' ', '　', '﻿', ' ', '\u0085', '​', '᠎'];

function idEdge(): IdIn[] {
  const ids = new Set<string>([...FIXTURE_IDS, ...HAND_PICKED_IDS, ...OFFSET_IDS].filter((id) => !VALIDITY_DRIFT.some((d) => d.toLowerCase() === id.toLowerCase())));
  for (const id of FIXTURE_IDS) {
    ids.add(id.toLowerCase());
    ids.add(id.toUpperCase());
  }
  return [...ids].map((id) => ({ id }));
}

function idRandom(rng: Rng): IdIn {
  const base = rng.pick(FIXTURE_IDS);
  const id = rng.weighted<() => string>([
    [() => mixedCase(rng, base), 35],
    [() => mutate(rng, base), 30],
    [() => randomOffsetId(rng), 20],
    [() => mutate(rng, mixedCase(rng, base)), 10],
    [() => base, 5],
  ])();
  return { id };
}

interface ValueOnly { value: string }

function schemaEdge(): ValueOnly[] {
  const cases: ValueOnly[] = [];
  const ids = ['UTC', 'Asia/Kolkata', 'America/New_York', 'Etc/GMT+5', '+05:30', 'Pacific/Apia', 'Not/AZone', '', ' ', 'asia/kolkata'];
  for (const id of ids) for (const pre of ID_PREFIX) for (const post of ID_PREFIX) cases.push({ value: `${pre}${id}${post}` });
  const spaces = (n: number): string => ' '.repeat(n);
  cases.push({ value: `${spaces(80)}UTC${spaces(80)}` }, { value: `${spaces(500)}UTC` }, { value: 'a'.repeat(80) }, { value: 'a'.repeat(81) });
  cases.push({ value: `+05:30${spaces(75)}` }, { value: `${'Etc/'.padEnd(80, 'x')}` }, { value: '\u{1F600}'.repeat(40) }, { value: '\u{1F600}'.repeat(41) });
  for (const id of OFFSET_IDS.slice(0, 40)) cases.push({ value: id });
  return cases;
}

function schemaRandom(rng: Rng): ValueOnly {
  const core = rng.weighted<() => string>([
    [() => rng.pick(DENSE_ZONES), 50],
    [() => idRandom(rng).id, 40],
    [() => rng.pick(HAND_PICKED_IDS), 10],
  ])();
  return { value: `${rng.pick(ID_PREFIX)}${core}${rng.pick(ID_PREFIX)}` };
}

// ---------------------------------------------------------------------------
// medianMinute
// ---------------------------------------------------------------------------

interface MedianIn { minutes: Array<number | null> }

function medianEdge(): MedianIn[] {
  return [
    { minutes: [] }, { minutes: [null] }, { minutes: [null, null] }, { minutes: [555] }, { minutes: [555, null] }, { minutes: [1, 2] }, { minutes: [1, 4] },
    { minutes: [0, 1] }, { minutes: [-1, 0] }, { minutes: [-3, -2] }, { minutes: [-2, -1] }, { minutes: [0.5, 1.5] }, { minutes: [-0.5, 0.5] },
    { minutes: [3, 1, 2] }, { minutes: [4, 1, 3, 2] }, { minutes: [555, 560, 600, null, 3] }, { minutes: [1439, 0, 720] }, { minutes: [1e15, 1e15 + 2] },
    { minutes: [0.1, 0.2] }, { minutes: [2.5, 3.5] }, { minutes: [-2.5, -3.5] }, { minutes: [9, 9, 9, 9] }, { minutes: [10, 20, 30, 40, 50, null, null] },
  ];
}

function medianRandom(rng: Rng): MedianIn {
  const n = rng.int(0, 9);
  const minutes: Array<number | null> = [];
  for (let i = 0; i < n; i++) {
    minutes.push(rng.weighted<() => number | null>([
      [() => rng.int(0, 1439), 55], [() => null, 15], [() => rng.int(-5, 1500) + rng.pick([0, 0.5, 0.25]), 20], [() => rng.pick([0, -0, 1e9, -1e9]), 10],
    ])());
  }
  return { minutes: minutes.map((m) => (Object.is(m, -0) ? 0 : m)) };
}

// ---------------------------------------------------------------------------
// Offset-change tables
// ---------------------------------------------------------------------------

interface TableIn { timeZone: string; fromYear: number; toYear: number; stepDays: number }
const TABLE_STEP_DAYS = 9;

function tableEdge(): TableIn[] {
  return FIXTURE_IDS.map((timeZone) => ({ timeZone, fromYear: 1970, toYear: 2100, stepDays: TABLE_STEP_DAYS }));
}

function tableRandom(rng: Rng): TableIn {
  const fromYear = rng.int(1970, 2090);
  return { timeZone: anyZoneId(rng), fromYear, toYear: fromYear + rng.int(1, 4), stepDays: rng.pick([1, 1, 2, 3, 7]) };
}

const tableOf = (i: TableIn): Array<[number, number]> =>
  offsetTransitions(i.timeZone, Date.UTC(i.fromYear, 0, 1) / 1000, Date.UTC(i.toYear, 0, 1) / 1000, i.stepDays);

// ---------------------------------------------------------------------------

export const specs: FnSpec<any>[] = [
  { module: 'tz', fn: 'isValidTimeZone', edge: idEdge, random: idRandom, call: ({ id }: IdIn) => isValidTimeZone(id) },
  {
    module: 'tz',
    fn: 'timeZoneSchema',
    edge: schemaEdge,
    random: schemaRandom,
    call: ({ value }: ValueOnly) => {
      const r = TimeZoneSchema.safeParse(value);
      return r.success ? { ok: true, data: r.data } : { ok: false };
    },
  },
  { module: 'tz', fn: 'zonedDateTimeParts', edge: valueEdge, random: valueRandom, call: ({ value, timeZone }: ValueIn) => zonedDateTimeParts(value, timeZone) },
  {
    module: 'tz',
    fn: 'zonedDateTimePartsWide',
    edge: () => WIDE_ZONES.flatMap((timeZone) => WIDE_INSTANTS.map((value) => ({ value, timeZone }))),
    random: (rng: Rng): ValueIn => ({ value: rng.pick([-1, 1]) * Math.floor(rng.next() * 8.64e15), timeZone: rng.pick(WIDE_ZONES) }),
    call: ({ value, timeZone }: ValueIn) => zonedDateTimeParts(value, timeZone),
  },
  { module: 'tz', fn: 'dateKeyInTimeZone', edge: valueEdge, random: valueRandom, call: ({ value, timeZone }: ValueIn) => dateKeyInTimeZone(value, timeZone) },
  {
    module: 'tz',
    fn: 'possibleInstantsForZonedDateTime',
    edge: partsEdge,
    random: partsRandom,
    call: ({ parts, timeZone }: PartsIn) => possibleInstantsForZonedDateTime(parts, timeZone).map(millis),
  },
  {
    module: 'tz',
    fn: 'instantForZonedDateTime',
    edge: partsEdge,
    random: partsRandom,
    call: ({ parts, timeZone }: PartsIn) => millis(instantForZonedDateTime(parts, timeZone)),
  },
  {
    module: 'tz',
    fn: 'localDayWindowInTimeZone',
    edge: dateEdge,
    random: dateRandom,
    call: ({ date, timeZone }: DateIn) => {
      const w = localDayWindowInTimeZone(date, timeZone);
      return w === null ? null : { start: w.start.getTime(), end: w.end.getTime() };
    },
  },
  {
    module: 'tz',
    fn: 'medianMinute',
    edge: medianEdge,
    random: medianRandom,
    // `Math.round(-0.5)` is -0, which the recorder cannot hold; JSON.stringify writes it as 0 anyway.
    call: ({ minutes }: MedianIn) => {
      const m = medianMinute(minutes);
      return Object.is(m, -0) ? 0 : m;
    },
  },
  { module: 'tz', fn: 'offsetTransitions', edge: tableEdge, random: tableRandom, call: tableOf },
];
