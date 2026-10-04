import { canonicalTimerEntryPayload, type TimeEntry } from '@grind/core';
import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';
import { MAX_DATE, MAX_EXACT, MIN, T0, genEntry, id, makeEntry, seg, tieId, ts, ulid } from './common';
import { boundaryStrings, iso, validString } from './dates';

type Like = Parameters<typeof canonicalTimerEntryPayload>[0];
type Stamp = number | string | Date;

const BOUNDARY = boundaryStrings();
const CLOSE_REASONS: Array<string | null> = [null, null, 'AGENT', 'AGENT_RECOVERY', 'LEASE_EXPIRED', 'SUPERSEDED', 'LEGACY_RECONCILED', '', 'other "reason"', 'x\u0001y'];

/** The instant `t` written as a number, a Date, or one of the supported ISO shapes. */
function stamp(rng: Rng, t: number): Stamp {
  const inRange = Math.abs(t) <= MAX_DATE;
  const how = rng.weighted<'number' | 'date' | 'iso' | 'offset' | 'shape' | 'boundary'>([
    ['number', 52], ['date', 10], ['iso', 14], ['offset', 9], ['shape', 9], ['boundary', 6],
  ]);
  if (!inRange || how === 'number') return t;
  if (how === 'date') return new Date(t);
  if (how === 'iso') return iso(t, null) ?? t;
  if (how === 'offset') return iso(t, rng.pick([330, -300, 60, -720, 840, 0, -60, 570]), rng.pick(['full', 'noMillis'] as const)) ?? t;
  if (how === 'shape') return validString(rng, t) ?? t;
  return rng.pick(BOUNDARY);
}

function toLike(rng: Rng, entry: TimeEntry): Like {
  const like: Record<string, unknown> = { id: entry.id, clientUuid: entry.clientUuid };
  if (entry.larkTaskGuid !== undefined) like.larkTaskGuid = entry.larkTaskGuid;
  like.source = entry.source;
  like.revision = rng.chance(0.1) ? null : entry.revision;
  like.startedAt = stamp(rng, entry.startedAt);
  like.endedAt = entry.endedAt === null ? null : stamp(rng, entry.endedAt);
  like.closeReason = rng.pick(CLOSE_REASONS);
  like.segments = entry.segments.map((s) => ({
    id: s.id,
    kind: s.kind,
    startedAt: stamp(rng, s.startedAt),
    endedAt: s.endedAt === null ? null : stamp(rng, s.endedAt),
  }));
  return like as unknown as Like;
}

/** Entries whose segments tie on startedAt, so the id tiebreak decides the order. */
function tied(rng: Rng): TimeEntry {
  const base = ts(rng);
  const count = rng.int(2, 5);
  const segments = Array.from({ length: count }, () => seg(tieId(rng), rng.pick(['WORK', 'MEETING', 'IDLE_TRIMMED'] as const), rng.chance(0.7) ? base : base + rng.pick([0, 1, 1000]), rng.chance(0.3) ? null : base + 5 * MIN));
  return makeEntry({ startedAt: base, segments: rng.shuffle(segments), id: id(rng), clientUuid: ulid(rng) });
}

const edgeLikes = (): Like[] => {
  const first: Like = {
    id: 'entry', clientUuid: 'client', source: 'AUTO', revision: 2, startedAt: 1_000, endedAt: 3_000, closeReason: 'AGENT',
    segments: [
      { id: 'b', kind: 'MEETING', startedAt: 2_000, endedAt: 3_000 },
      { id: 'a', kind: 'WORK', startedAt: 1_000, endedAt: 2_000 },
    ],
  };
  const second: Like = {
    id: 'entry', clientUuid: 'client', larkTaskGuid: null, source: 'AUTO', revision: 2, startedAt: new Date(1_000), endedAt: new Date(3_000).toISOString(), closeReason: 'AGENT',
    segments: [
      { id: 'a', kind: 'WORK', startedAt: new Date(1_000), endedAt: new Date(2_000) },
      { id: 'b', kind: 'MEETING', startedAt: new Date(2_000).toISOString(), endedAt: 3_000 },
    ],
  };
  const open: Like = { id: 'o', clientUuid: 'c', larkTaskGuid: 'g', source: 'MANUAL', revision: null, startedAt: '2024-06-15', endedAt: null, closeReason: null, segments: [{ id: 'x', kind: 'WORK', startedAt: '2024-06-15T00:00:00Z', endedAt: null }] };
  const fractional: Like = {
    id: 'r', clientUuid: 'c', larkTaskGuid: null, source: 'AUTO', revision: 7, startedAt: 1791133383891.2627, endedAt: 1791133448770.0293, closeReason: 'AGENT',
    segments: [
      { id: 'b', kind: 'MEETING', startedAt: 1791133430180.8308, endedAt: 1791133448770.0293 },
      { id: 'a', kind: 'WORK', startedAt: 1791133383891.2627, endedAt: 1791133430180.8308 },
      { id: 'c', kind: 'WORK', startedAt: 0.1 + 0.2, endedAt: 1e-7 },
      { id: 'd', kind: 'WORK', startedAt: 4503599627370495.5, endedAt: 1e21 },
      { id: 'e', kind: 'WORK', startedAt: 1.5e-7, endedAt: 123456789012345680000 },
    ],
  };
  const bad = (value: Stamp): Like => ({ ...first, startedAt: value });
  const badSegment = (value: Stamp): Like => ({ ...first, segments: [{ id: 'a', kind: 'WORK', startedAt: 1, endedAt: value }] });
  const empty: Like = { ...first, segments: [], endedAt: null, closeReason: null };
  const ties: Like = {
    ...first,
    segments: ['b', 'B', 'a', 'A', 'a1', 'a10', 'a2', 'é', 'é', 'ss', 'ß', '', ' ', '_', '-'].map((sid) => ({ id: sid, kind: 'WORK' as const, startedAt: 5, endedAt: 6 })),
  };
  const extremes: Like = { ...first, startedAt: -MAX_EXACT, endedAt: MAX_EXACT, revision: MAX_EXACT, segments: [{ id: 'h', kind: 'WORK', startedAt: MAX_EXACT, endedAt: -MAX_EXACT }] };
  const limits: Like = { ...first, startedAt: new Date(MAX_DATE), endedAt: new Date(-MAX_DATE), segments: [{ id: 'h', kind: 'WORK', startedAt: new Date(-MAX_DATE), endedAt: new Date(MAX_DATE).toISOString() }] };
  return [
    first, second, fractional, open, empty, ties, extremes, limits,
    bad(''), bad('2024-13-01T00:00:00Z'), bad('2024-02-30T25:00:00Z'), bad('+275760-09-13T00:00:00.001Z'), badSegment('-000000-01-01'),
    badSegment('2024-02-30'), badSegment('2024-06-15T24:00:00.000Z'), bad(T0), { ...first, segments: [{ id: 'z', kind: 'IDLE_TRIMMED', startedAt: 0, endedAt: 0 }] },
  ];
};

function run(entry: Like): unknown {
  try {
    return { ok: canonicalTimerEntryPayload(entry) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

/** Run the real function on the Date-bearing input AND on its JSON form; they must agree. */
function callBoth(entry: Like): string {
  const direct = run(entry);
  const viaJson = run(JSON.parse(JSON.stringify(entry)) as Like);
  if (JSON.stringify(direct) !== JSON.stringify(viaJson)) {
    throw new Error(`harness: Date and its ISO string disagree for ${JSON.stringify(entry)}`);
  }
  if ('error' in (direct as object)) throw new Error((direct as { error: string }).error);
  return (direct as { ok: string }).ok;
}

export const specs: FnSpec<any>[] = [
  {
    module: 'timerLedger',
    fn: 'canonicalTimerEntryPayload',
    edge: () => edgeLikes().map((entry) => ({ entry })),
    random: (rng) => ({ entry: toLike(rng, rng.chance(0.2) ? tied(rng) : genEntry(rng)) }),
    record: ({ entry }: { entry: Like }) => ({ entry: JSON.parse(JSON.stringify(entry)) as Like }),
    call: ({ entry }: { entry: Like }) => callBoth(entry),
  },
];
