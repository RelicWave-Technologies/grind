import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';
import { asyncSpec } from './asyncSpec';
import { remote } from './syncRemote';
import { aroundLimit, filler, mixed, token, ULID_ALPHABET } from './syncText';

/**
 * `activity/sync.ts::flushActivity`, the REAL function: the longest
 * byte-bounded prefix of the backlog, the per-field UTF-16 caps (emoji across
 * the cut), `toISOString` of the bucket, `JSON.stringify` of the body. The
 * network is the `syncApi.ts` stub, which records `JSON.stringify(body)` exactly
 * as `apiClient.ts::rawFetch` would send it. The Rust sender must produce the
 * same ids, the same split and the same bytes.
 */
const crate = 'timo-sync' as const;
const module = 'activitySync';

type Row = Record<string, unknown>;
interface Input { rows: Row[]; pending: string[] }

const NUMS: readonly number[] = [0, 1, 2, 5, 17, 300, 4999, 123456, 2 ** 31, 2 ** 40, 0.1, 0.5, 1 / 3, 0.30000000000000004, 1e-7, 1e21, 5e-324, 123456789012345680000];

function num(rng: Rng): number {
  return rng.chance(0.7) ? rng.int(0, 5000) : rng.pick(NUMS);
}

function cv(rng: Rng): number | null {
  return rng.weighted<() => number | null>([
    [() => null, 25],
    [() => rng.next(), 40],
    [() => rng.pick([0, 1, 0.5, 1e-7, 1 / 3, 2 / 3, 1.7976931348623157e308, 0.1 + 0.2]), 25],
    [() => Math.round(rng.next() * 1e9) / 1e3, 10],
  ])();
}

function field(rng: Rng, limit: number): string | null {
  // The 2 KiB URL cap is rare here: one such field is as big as a whole ordinary row.
  const heavy = limit >= 2048 ? 0.15 : 1;
  return rng.weighted<() => string | null>([
    [() => null, 30],
    [() => mixed(rng, rng.int(0, 6)), 30],
    [() => aroundLimit(rng, limit), 25 * heavy],
    [() => filler(rng.int(limit - 1, limit + 40)), 8 * heavy],
    [() => mixed(rng, rng.int(40, 120)), 7 * heavy],
  ])();
}

let counter = 0;
function row(rng: Rng, timeEntryIds: string[], big: boolean): Row {
  counter += 1;
  const bucket = 1_791_133_380_000 + rng.int(-30, 30) * 60_000;
  return {
    id: `r${counter}-${token(rng, 6, ULID_ALPHABET)}`,
    timeEntryId: rng.chance(0.2) ? null : rng.pick(timeEntryIds),
    bucketStart: rng.chance(0.03) ? bucket + rng.pick([0.5, 0.999, 0.25]) : rng.chance(0.01) ? 8.64e15 + 1 : bucket,
    keystrokes: num(rng),
    clicks: num(rng),
    mouseDistancePx: num(rng),
    scrollEvents: num(rng),
    ikiCv: cv(rng),
    moveSpeedCv: cv(rng),
    pathStraightness: cv(rng),
    activeApp: field(rng, 120),
    activeAppBundle: field(rng, 200),
    activeTitle: field(rng, 300),
    activeUrl: big && rng.chance(0.8) ? `https://x/${filler(rng.int(1500, 2600))}` : field(rng, 2048),
    synced: 0,
  };
}

/** A minimal row, for the 500-row cap case (kept small so the fixture is). */
function tiny(rng: Rng, timeEntryIds: string[]): Row {
  counter += 1;
  return { id: `t${counter}`, timeEntryId: rng.pick(timeEntryIds), bucketStart: 1_791_133_380_000 + counter * 60_000, keystrokes: rng.int(0, 99), clicks: 0, mouseDistancePx: 0, scrollEvents: 0, ikiCv: null, moveSpeedCv: null, pathStraightness: null, activeApp: 'A', activeAppBundle: null, activeTitle: null, activeUrl: null, synced: 0 };
}

function generate(rng: Rng): Input {
  const timeEntryIds = ['entry-a', 'entry-b', 'entry-c'];
  const count = rng.weighted<number>([
    [0, 3],
    [rng.int(1, 6), 65],
    [rng.int(7, 11), 30],
    [rng.int(22, 36), 3],
    [rng.int(480, 520), 1],
  ]);
  // Big URLs (the byte split) only where the case is not already huge.
  const big = count > 20 && count < 200;
  const rows = Array.from({ length: count }, () => (count >= 200 ? tiny(rng, timeEntryIds) : row(rng, timeEntryIds, big)));
  // The invalid bucket is rare; keep most inputs valid so the batching is exercised.
  const pending = timeEntryIds.filter(() => rng.chance(0.25));
  return { rows, pending };
}

const single = (over: Row): Input => ({
  rows: [{ id: 'one', timeEntryId: 't', bucketStart: 0, keystrokes: 1, clicks: 1, mouseDistancePx: 0, scrollEvents: 0, ikiCv: 0, moveSpeedCv: 0, pathStraightness: 0, activeApp: 'app', activeAppBundle: null, activeTitle: null, activeUrl: null, synced: 0, ...over }],
  pending: [],
});

const edge = (): Input[] => [
  { rows: [], pending: [] },
  single({}),
  single({ activeTitle: `${'a'.repeat(299)}\u{1F600}tail` }),
  single({ activeTitle: `${'a'.repeat(298)}\u{1F600}tail` }),
  single({ activeApp: 'a'.repeat(121), activeAppBundle: 'b'.repeat(201), activeTitle: 't'.repeat(301), activeUrl: 'u'.repeat(5000) }),
  single({ activeUrl: 'u'.repeat(5000) }),
  single({ bucketStart: 8.64e15 + 1 }),
  single({ bucketStart: -62198755200000 }),
  single({ bucketStart: 253402300800000 }),
  single({ ikiCv: 1e21, moveSpeedCv: 5e-324, pathStraightness: 0.30000000000000004 }),
  { rows: single({ timeEntryId: 'p' }).rows, pending: ['p'] },
];

export const specs: Array<FnSpec<Input>> = [
  await asyncSpec<Input>({
    module,
    fn: 'flushActivity',
    edge,
    random: generate,
    run: (input) => remote('flush', input),
  }),
].map((spec) => ({ ...spec, crate }));
