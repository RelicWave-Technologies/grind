import type { Segment, SegmentKind, TimeEntry } from '@grind/core';
import type { Rng } from '../prng';

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;
export const T0 = 1_700_000_000_000;
/** 2^53: the largest magnitude a double (and so a JSON number) holds exactly. */
export const MAX_EXACT = 2 ** 53;
export const MAX_SAFE = Number.MAX_SAFE_INTEGER;
/** Date's own limit: +-8.64e15 ms. */
export const MAX_DATE = 8_640_000_000_000_000;

const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0, ms = 0): number =>
  Date.UTC(y, mo - 1, d, h, mi, s, ms);

/**
 * Instants where wall-clock arithmetic goes wrong: local midnights and DST
 * transitions in four IANA zones (written as the UTC instants they fall on, so
 * the fixtures do not depend on the machine's time zone or tz database), the
 * epoch, leap days and the numeric limits.
 */
export const ANCHORS: readonly number[] = [
  0, 1, -1, T0,
  // America/New_York: spring forward 2024-03-10 02:00 EST, fall back 2024-11-03 02:00 EDT.
  utc(2024, 3, 10, 7), utc(2024, 11, 3, 6), utc(2024, 3, 10, 5), utc(2024, 11, 3, 4),
  // Europe/London: 2024-03-31 01:00 UTC and 2024-10-27 01:00 UTC.
  utc(2024, 3, 31, 1), utc(2024, 10, 27, 1),
  // Asia/Kolkata (+05:30, no DST): local midnight 2024-06-15 00:00 IST.
  utc(2024, 6, 14, 18, 30), utc(2024, 6, 15, 18, 30),
  // Australia/Lord_Howe (30-minute DST): 2024-10-06 02:00 and 2024-04-07 02:00 local.
  utc(2024, 10, 5, 15, 30), utc(2024, 4, 6, 15),
  // Pacific/Apia skipped 2011-12-30 entirely.
  utc(2011, 12, 30, 10),
  // Midnights, leap days, year ends.
  utc(2024, 1, 1), utc(2024, 2, 29), utc(2024, 12, 31, 23, 59, 59, 999), utc(2000, 2, 29), utc(1999, 12, 31, 23, 59, 59, 999),
  utc(1969, 12, 31, 23, 59, 59, 999), utc(1900, 1, 1), -DAY, DAY,
  // Limits.
  MAX_DATE, -MAX_DATE, MAX_SAFE, -MAX_SAFE, MAX_EXACT, -MAX_EXACT, 2 ** 52, -(2 ** 52), 2 ** 31, -(2 ** 31), 2 ** 32,
];

/** Offsets that land on or either side of the boundaries above. */
export const DELTAS: readonly number[] = [
  0, 0, 0, 1, -1, 2, -2, 500, -500, 999, -999, 1000, -1000, 1001, 1500, 30_000, -30_000, 30_500, 59_999, 60_000, -60_000,
  MIN * 5, MIN * 7, MIN * 10, MIN * 15, MIN * 30, 3_599_999, HOUR, -HOUR, HOUR * 2, HOUR * 12, 86_399_999, DAY, -DAY, DAY * 7,
];

export function clip(n: number): number {
  return Math.max(-MAX_EXACT, Math.min(MAX_EXACT, n));
}

/**
 * The agent's timer clock is `anchorServer + (performance.now() - anchorMono)`,
 * so real timestamps are fractional doubles (1791133383891.2627). These are
 * the sub-millisecond parts the generators add, including the nasty ones: halves,
 * tiny fractions, repeating decimals, and the tails of real rows.
 */
const FRACTIONS: readonly number[] = [
  0.5, 0.25, 0.75, 0.1, 0.2, 0.3, 0.7, 0.9, 0.999, 0.9999999, 0.0000001, 1e-9, 0.2627, 0.0293, 0.8308, 0.776, 1 / 3, 2 / 3, 0.49999999999999994, 0.5000000000000001,
];

/** A sub-millisecond fraction, or occasionally a random one with many digits. */
export function fraction(rng: Rng): number {
  return rng.chance(0.65) ? rng.pick(FRACTIONS) : rng.next();
}

/** `x` plus a fraction with probability `p` (the result stays a finite double). */
export function maybeFrac(rng: Rng, x: number, p = 0.55): number {
  if (!rng.chance(p)) return x;
  const f = fraction(rng);
  return clip(x < 0 && rng.chance(0.5) ? x - f : x + f);
}

/** Real fractional rows from a user's agent.db, as anchors. */
export const REAL_ROWS: readonly number[] = [
  1791133383891.2627, 1791133448770.0293, 1791133430180.8308, 1791133436609.776,
];

/**
 * Fractional instants for the hand-picked cases: a real row's tail, halves,
 * tiny and repeating fractions, and the largest magnitudes a fraction survives
 * at (2^52 - 0.5 is the last half-integer a double holds).
 */
export const FRACTIONAL_ATS: readonly number[] = [
  1791133430180.8308, 1791133436609.776, 0.5, -0.5, 0.1 + 0.2, 1e-7, -1e-7, 1 / 3, 1700000000000.5, 1700000000000.0000002, 4503599627370495.5, -4503599627370495.5, 4503599627370496.5, 8639999999999999.5,
];

/** A timestamp, mostly near an anchor, sometimes just random. */
export function ts(rng: Rng): number {
  return maybeFrac(rng, integerTs(rng));
}

function integerTs(rng: Rng): number {
  return rng.weighted<() => number>([
    [() => T0 + rng.int(-DAY, DAY), 40],
    [() => clip(rng.pick(ANCHORS) + rng.pick(DELTAS)), 44],
    [() => rng.int(-(10 ** 12), 10 ** 13), 8],
    [() => rng.wideInt(), 4],
    [() => rng.pick([MAX_SAFE, -MAX_SAFE, MAX_EXACT, -MAX_EXACT, MAX_DATE, -MAX_DATE]), 3],
    [() => rng.pick(REAL_ROWS) + rng.pick(DELTAS), 6],
  ])();
}

/** A timestamp close to `base` (mostly) or unrelated (sometimes). */
export function near(rng: Rng, base: number): number {
  if (rng.chance(0.08)) return ts(rng);
  return maybeFrac(rng, clip(base + rng.pick(DELTAS)), 0.4);
}

const SIMPLE_IDS = ['s1', 's2', 's3', 's4', 's5', 's6', 'a', 'b', 'c', 'A', 'B', 'C', 'seg-1', 'seg-2', 'seg_1', 'x1', 'x10', 'x2'];
const ODD_IDS = [
  '', ' ', '0', '00', '1', '10', '2', 'z', 'Z', 'ab', 'aB', 'Ab', 'AB', 'a b', 'a-b', 'a_b', 'a.b', 'é', 'É', 'é', 'é', 'ß', 'ss', 'Ω', 'ω', '中', '😀', 'ä', 'ä',
  '\u0001', 'x\u0001', 'x', '\t', '\n', 'line\nbreak', '"q"', 'back\\slash', ' ', '\u007f', '~', '`', '[a]', '{a}', '@', '#', '$', '%', '+', '<', '=', '>', '|', '/', '*', '&', "'",
];
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(rng: Rng): string {
  let out = '';
  for (let i = 0; i < 26; i++) out += CROCKFORD[rng.int(0, CROCKFORD.length - 1)];
  return out;
}

export function id(rng: Rng): string {
  return rng.weighted<() => string>([
    [() => rng.pick(SIMPLE_IDS), 62],
    [() => rng.pick(ODD_IDS), 26],
    [() => ulid(rng), 12],
  ])();
}

/** Ids that tie often, so the sort tiebreaks run. */
export function tieId(rng: Rng): string {
  return rng.pick(['a', 'b', 'A', 'B', 'a1', 'a2', 'a10', 'é', 'é', 'é', 'ss', 'ß']);
}

export type Mode = 'valid' | 'sloppy' | 'wild';
const KINDS: readonly SegmentKind[] = ['WORK', 'MEETING', 'IDLE_TRIMMED'];
const KIND_WEIGHTS: ReadonlyArray<readonly [SegmentKind, number]> = [['WORK', 60], ['MEETING', 20], ['IDLE_TRIMMED', 20]];

export function kind(rng: Rng): SegmentKind {
  return rng.weighted(KIND_WEIGHTS);
}

export const seg = (id: string, kind: SegmentKind, startedAt: number, endedAt: number | null): Segment => ({
  id,
  kind,
  startedAt,
  endedAt,
});

/** Key order is the TypeScript interface's, which is the order the Rust emits. */
export function makeEntry(fields: {
  id?: string;
  clientUuid?: string;
  userId?: string;
  larkTaskGuid?: string | null | undefined;
  source?: 'AUTO' | 'MANUAL';
  revision?: number;
  startedAt: number;
  endedAt?: number | null;
  pauseReason?: TimeEntry['pauseReason'];
  closeReason?: TimeEntry['closeReason'];
  segments: Segment[];
}): TimeEntry {
  const entry: Record<string, unknown> = {
    id: fields.id ?? 'te_1',
    clientUuid: fields.clientUuid ?? 'uuid_1',
    userId: fields.userId ?? 'u_1',
  };
  if ('larkTaskGuid' in fields && fields.larkTaskGuid !== undefined) entry.larkTaskGuid = fields.larkTaskGuid;
  entry.source = fields.source ?? 'AUTO';
  entry.revision = fields.revision ?? 1;
  entry.startedAt = fields.startedAt;
  entry.endedAt = fields.endedAt ?? null;
  entry.pauseReason = fields.pauseReason ?? null;
  entry.closeReason = fields.closeReason ?? null;
  entry.segments = fields.segments;
  return entry as unknown as TimeEntry;
}

function timeline(rng: Rng): Segment[] {
  const count = rng.weighted([[1, 22], [2, 26], [3, 22], [4, 14], [5, 9], [6, 5], [0, 2]] as const);
  const segments: Segment[] = [];
  let cursor = ts(rng);
  const usedIds = new Set<string>();
  for (let i = 0; i < count; i++) {
    const startedAt = clip(cursor + (i > 0 && rng.chance(0.4) ? rng.pick(DELTAS.filter((d) => d >= 0)) : 0));
    const last = i === count - 1;
    const open = last && rng.chance(0.45);
    const endedAt = open ? null : clip(startedAt + (rng.chance(0.08) ? 0 : maybeFrac(rng, Math.abs(rng.pick(DELTAS)) + (rng.chance(0.5) ? rng.int(1, 3_600_000) : 0), 0.5)));
    let segId = id(rng);
    while (usedIds.has(segId) && rng.chance(0.9)) segId = ulid(rng);
    usedIds.add(segId);
    segments.push(seg(segId, kind(rng), startedAt, endedAt));
    cursor = endedAt ?? startedAt;
  }
  return segments;
}

function perturb(rng: Rng, entry: TimeEntry): TimeEntry {
  const segs = entry.segments.map((s) => ({ ...s }));
  const edits = rng.int(1, 3);
  const out: TimeEntry = { ...entry, segments: segs };
  for (let n = 0; n < edits; n++) {
    const i = segs.length === 0 ? 0 : rng.int(0, segs.length - 1);
    const s = segs[i];
    const j = segs.length === 0 ? 0 : rng.int(0, segs.length - 1);
    switch (rng.int(0, 8)) {
      case 0: if (s && segs[j]) s.id = segs[j]!.id; break; // duplicate id
      case 1: if (s && segs[j]) { segs[i] = segs[j]!; segs[j] = s; } break; // out of order
      case 2: if (s) s.startedAt = near(rng, s.startedAt); break; // overlap / gap
      case 3: if (s) s.endedAt = near(rng, s.startedAt - 1); break; // inverted
      case 4: if (s) s.endedAt = null; break; // extra open segment
      case 5: out.startedAt = near(rng, out.startedAt); break; // entry start mismatch
      case 6: out.endedAt = near(rng, out.startedAt); break; // closed entry with open segment
      case 7: if (s) s.endedAt = s.startedAt; break; // zero-length
      default: if (s) s.kind = kind(rng); break;
    }
  }
  return out;
}

function wildSegments(rng: Rng): Segment[] {
  const count = rng.int(0, 5);
  const out: Segment[] = [];
  for (let i = 0; i < count; i++) {
    const startedAt = ts(rng);
    out.push(seg(id(rng), kind(rng), startedAt, rng.chance(0.25) ? null : near(rng, startedAt)));
  }
  return out;
}

function guid(rng: Rng): string | null | undefined {
  return rng.weighted<string | null | undefined>([[undefined, 40], [null, 30], ['guid_xyz', 20], [ulid(rng), 10]]);
}

export function genEntry(rng: Rng, mode?: Mode): TimeEntry {
  const m: Mode = mode ?? rng.weighted<Mode>([['valid', 52], ['sloppy', 34], ['wild', 14]]);
  const segments = m === 'wild' ? wildSegments(rng) : timeline(rng);
  const first = segments[0];
  const lastSeg = segments[segments.length - 1];
  const open = segments.some((s) => s.endedAt === null);
  const entry = makeEntry({
    id: rng.pick(['te_1', 'te_2', 'te_3', 'e1', 'E1']),
    clientUuid: rng.pick(['uuid_1', 'uuid_2', 'cu1', ulid(rng)]),
    userId: rng.pick(['u_1', 'u_2', 'u1']),
    larkTaskGuid: guid(rng),
    source: rng.chance(0.8) ? 'AUTO' : 'MANUAL',
    revision: rng.weighted<number>([[1, 30], [2, 20], [rng.int(0, 1000), 36], [0, 6], [MAX_SAFE, 4], [MAX_EXACT, 4]]),
    startedAt: m === 'wild' ? ts(rng) : (first?.startedAt ?? ts(rng)),
    endedAt: open ? null : rng.chance(0.7) ? (lastSeg?.endedAt ?? null) : rng.chance(0.5) ? null : ts(rng),
    pauseReason: rng.weighted<TimeEntry['pauseReason']>([[null, 60], ['IDLE', 14], ['MANUAL', 14], ['PERMISSION_REQUIRED', 12]]),
    closeReason: rng.weighted<TimeEntry['closeReason']>([[null, 60], ['AGENT', 25], ['AGENT_RECOVERY', 15]]),
    segments,
  });
  return m === 'sloppy' ? perturb(rng, entry) : entry;
}

/** A valid running entry (one open WORK segment) like the TS tests' baseEntry. */
export function baseEntry(startedAt = T0): TimeEntry {
  return makeEntry({
    id: 'te_1',
    clientUuid: 'uuid_1',
    userId: 'u_1',
    larkTaskGuid: null,
    startedAt,
    segments: [seg('s_1', 'WORK', startedAt, null)],
  });
}

export function allKinds(): readonly SegmentKind[] {
  return KINDS;
}

/** A time to act at, in relation to the entry's own timestamps. */
export function atFor(rng: Rng, entry: TimeEntry): number {
  const open = entry.segments.find((s) => s.endedAt === null);
  const last = entry.segments[entry.segments.length - 1];
  const base = rng.weighted<number>([
    [open?.startedAt ?? entry.startedAt, 40],
    [last?.endedAt ?? last?.startedAt ?? entry.startedAt, 20],
    [entry.startedAt, 15],
    [ts(rng), 10],
    [rng.pick(entry.segments.length ? entry.segments : [seg('x', 'WORK', 0, 0)]).startedAt, 15],
  ]);
  return near(rng, base);
}

/**
 * An entry that is still running (an open segment, no `endedAt`) with
 * probability `p`, otherwise whatever `genEntry` gives. Most mutations only
 * get past their guards on a running entry, so the success paths need this.
 */
export function genRunning(rng: Rng, p = 0.8): TimeEntry {
  if (!rng.chance(p)) return genEntry(rng);
  for (let i = 0; i < 40; i++) {
    const entry = genEntry(rng);
    if (entry.endedAt === null && entry.segments.some((s) => s.endedAt === null)) return entry;
  }
  return baseEntry(ts(rng));
}
