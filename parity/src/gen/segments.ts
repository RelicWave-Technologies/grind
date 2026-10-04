import {
  applyIdleDiscard,
  closeOpenSegment,
  closeTimeEntry,
  createTimeEntry,
  getOpenSegment,
  openSegment,
  recoverStaleEntry,
  totalIdleTrimmedMs,
  totalWorkedMs,
  validateEntry,
  type TimeEntry,
} from '@grind/core';
import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';
import {
  DAY, HOUR, MAX_EXACT, MAX_SAFE, MIN, T0, FRACTIONAL_ATS, atFor, baseEntry, clip, genEntry, genRunning, id, kind, makeEntry, near, seg, ts, ulid,
} from './common';

const module = 'segments';

type Args = Parameters<typeof createTimeEntry>[0];

const createCases: Args[] = [
  { id: 'te_1', clientUuid: 'uuid_1', userId: 'u_1', startedAt: T0, segmentId: 's_1' },
  { id: 'te', clientUuid: 'u', userId: 'u1', larkTaskGuid: 'guid_xyz', source: 'MANUAL', startedAt: T0, segmentId: 's' },
  { id: 'te', clientUuid: 'u', userId: 'u1', larkTaskGuid: null, source: 'AUTO', startedAt: -1, segmentId: 's' },
  { id: '', clientUuid: '', userId: '', larkTaskGuid: '', startedAt: 0, segmentId: '' },
  { id: 'te', clientUuid: 'u', userId: 'u1', startedAt: MAX_EXACT, segmentId: 'é' },
  { id: 'te', clientUuid: 'u', userId: 'u1', startedAt: -MAX_EXACT, segmentId: 'x\u0001"\\' },
];

function createArgs(rng: Rng): Args {
  const args: Record<string, unknown> = { id: id(rng), clientUuid: id(rng), userId: id(rng) };
  const guidMode = rng.int(0, 3);
  if (guidMode === 1) args.larkTaskGuid = null;
  if (guidMode === 2) args.larkTaskGuid = ulid(rng);
  if (guidMode === 3) args.larkTaskGuid = '';
  const sourceMode = rng.int(0, 2);
  if (sourceMode === 1) args.source = 'AUTO';
  if (sourceMode === 2) args.source = 'MANUAL';
  args.startedAt = ts(rng);
  args.segmentId = id(rng);
  return args as unknown as Args;
}

/** The entries every function is exercised on by hand. */
function edgeEntries(): TimeEntry[] {
  const running = baseEntry();
  const closedSeg = makeEntry({ startedAt: T0, segments: [seg('a', 'WORK', T0, T0 + 10 * MIN)] });
  const closed = makeEntry({ startedAt: T0, endedAt: T0 + 10 * MIN, closeReason: 'AGENT', segments: [seg('a', 'WORK', T0, T0 + 10 * MIN)] });
  const meeting = makeEntry({ startedAt: T0, segments: [seg('a', 'WORK', T0, T0 + 5 * MIN), seg('b', 'MEETING', T0 + 5 * MIN, null)] });
  const firstOpen = makeEntry({ startedAt: T0, segments: [seg('a', 'WORK', T0, null), seg('b', 'WORK', T0 + MIN, T0 + 2 * MIN)] });
  const twoOpen = makeEntry({ startedAt: T0, segments: [seg('a', 'WORK', T0, null), seg('b', 'WORK', T0 + MIN, null)] });
  const empty = makeEntry({ startedAt: T0, segments: [] });
  const withIdle = makeEntry({
    startedAt: T0,
    segments: [seg('a', 'WORK', T0, T0 + 8 * MIN), seg('i', 'IDLE_TRIMMED', T0 + 8 * MIN, T0 + 15 * MIN), seg('b', 'WORK', T0 + 15 * MIN, null)],
  });
  const openIdle = makeEntry({ startedAt: T0, segments: [seg('i', 'IDLE_TRIMMED', T0, null)] });
  const hugeRevision = { ...running, revision: MAX_SAFE };
  const exactRevision = { ...running, revision: MAX_EXACT };
  const huge = makeEntry({ startedAt: -MAX_SAFE, segments: [seg('a', 'WORK', -MAX_SAFE, MAX_SAFE), seg('b', 'MEETING', -3, MAX_EXACT - 1)] });
  const zeroLen = makeEntry({ startedAt: T0, segments: [seg('a', 'WORK', T0, T0)] });
  const dup = makeEntry({ startedAt: T0, endedAt: T0 + 20 * MIN, segments: [seg('dup', 'WORK', T0, T0 + 10 * MIN), seg('dup', 'WORK', T0 + 10 * MIN, T0 + 20 * MIN)] });
  const overlap = makeEntry({ startedAt: T0, segments: [seg('a', 'WORK', T0, T0 + 10 * MIN), seg('b', 'WORK', T0 + 5 * MIN, null)] });
  const missingGuid = makeEntry({ startedAt: T0, larkTaskGuid: undefined, segments: [seg('a', 'WORK', T0, null)] });
  const guidString = makeEntry({ startedAt: T0, larkTaskGuid: 'g', segments: [seg('a', 'WORK', T0, null)] });
  const real = makeEntry({
    startedAt: 1791133383891.2627,
    endedAt: 1791133448770.0293,
    closeReason: 'AGENT',
    segments: [seg('a', 'WORK', 1791133383891.2627, 1791133430180.8308), seg('b', 'MEETING', 1791133430180.8308, 1791133448770.0293)],
  });
  const realOpen = makeEntry({ startedAt: 1791133383891.2627, segments: [seg('a', 'WORK', 1791133383891.2627, 1791133430180.8308), seg('b', 'WORK', 1791133430180.8308, null)] });
  const halves = makeEntry({ startedAt: 0.5, revision: 0.5 + 1, segments: [seg('a', 'WORK', 0.5, 1.5), seg('b', 'IDLE_TRIMMED', 1.5, 2.25), seg('c', 'WORK', 2.25, null)] });
  const tiny = makeEntry({ startedAt: 1e-7, segments: [seg('a', 'WORK', 1e-7, 3e-7), seg('b', 'WORK', 3e-7, null)] });
  const bigFraction = makeEntry({ startedAt: 4503599627370495.5, segments: [seg('a', 'WORK', 4503599627370495.5, 4503599627370496.5), seg('b', 'WORK', 4503599627370496.5, null)] });
  return [running, real, realOpen, halves, tiny, bigFraction, closedSeg, closed, meeting, firstOpen, twoOpen, empty, withIdle, openIdle, hugeRevision, exactRevision, huge, zeroLen, dup, overlap, missingGuid, guidString];
}

export const specs: FnSpec<any>[] = [
  {
    module,
    fn: 'createTimeEntry',
    edge: () => createCases,
    random: (rng) => createArgs(rng),
    call: (args: Args) => createTimeEntry(args),
  } satisfies FnSpec<Args>,
  {
    module,
    fn: 'getOpenSegment',
    edge: () => edgeEntries().map((entry) => ({ entry })),
    random: (rng) => ({ entry: genEntry(rng) }),
    call: ({ entry }: { entry: TimeEntry }) => getOpenSegment(entry),
  },
  {
    module,
    fn: 'closeOpenSegment',
    edge: () => {
      const cases: Array<{ entry: TimeEntry; at: number }> = [];
      for (const entry of edgeEntries()) {
        cases.push({ entry, at: T0 + 10 * MIN }, { entry, at: T0 - 1 }, { entry, at: T0 }, { entry, at: -MAX_EXACT }, { entry, at: MAX_EXACT });
        for (const at of FRACTIONAL_ATS) cases.push({ entry, at });
      }
      return cases;
    },
    random: (rng) => {
      const entry = genRunning(rng);
      return { entry, at: atFor(rng, entry) };
    },
    call: ({ entry, at }: { entry: TimeEntry; at: number }) => closeOpenSegment(entry, at),
  },
  {
    module,
    fn: 'openSegment',
    edge: () => {
      const cases: Array<{ entry: TimeEntry; args: { kind: 'WORK' | 'MEETING' | 'IDLE_TRIMMED'; at: number; segmentId: string } }> = [];
      for (const entry of edgeEntries()) {
        cases.push(
          { entry, args: { kind: 'MEETING', at: T0 + 5 * MIN, segmentId: 's_2' } },
          { entry, args: { kind: 'WORK', at: T0 + 20 * MIN, segmentId: 's_3' } },
          { entry, args: { kind: 'IDLE_TRIMMED', at: T0, segmentId: 'x' } },
          { entry, args: { kind: 'WORK', at: T0 - 1, segmentId: 'x' } },
          { entry, args: { kind: 'WORK', at: MAX_EXACT, segmentId: 'x' } },
        );
        for (const at of FRACTIONAL_ATS) cases.push({ entry, args: { kind: 'MEETING', at, segmentId: 'f' } });
      }
      return cases;
    },
    random: (rng) => {
      const entry = genRunning(rng);
      return { entry, args: { kind: kind(rng), at: atFor(rng, entry), segmentId: id(rng) } };
    },
    call: ({ entry, args }: { entry: TimeEntry; args: Parameters<typeof openSegment>[1] }) => openSegment(entry, args),
  },
  {
    module,
    fn: 'closeTimeEntry',
    edge: () => {
      const cases: Array<{ entry: TimeEntry; at: number }> = [];
      for (const entry of edgeEntries()) {
        cases.push({ entry, at: T0 + 30 * MIN }, { entry, at: T0 - 1 }, { entry, at: T0 + 99 * MIN }, { entry, at: MAX_EXACT });
        for (const at of FRACTIONAL_ATS) cases.push({ entry, at });
      }
      return cases;
    },
    random: (rng) => {
      const entry = genRunning(rng);
      return { entry, at: atFor(rng, entry) };
    },
    call: ({ entry, at }: { entry: TimeEntry; at: number }) => closeTimeEntry(entry, at),
  },
  {
    module,
    fn: 'applyIdleDiscard',
    edge: () => {
      const cases: Array<{ entry: TimeEntry; args: Parameters<typeof applyIdleDiscard>[1] }> = [];
      const pairs: Array<[number, number]> = [
        [T0 + 8 * MIN, T0 + 15 * MIN], [T0 + 5 * MIN, T0 + 30 * MIN], [T0, T0 + 12 * MIN], [T0 + 10 * MIN, T0 + 5 * MIN],
        [T0 + 10 * MIN, T0 + 10 * MIN], [T0 - 5 * MIN, T0 - 2 * MIN], [T0 - 5 * MIN, T0 + 1], [-MAX_EXACT, MAX_EXACT], [T0, T0],
        [1791133430180.8308, 1791133436609.776], [0.5, 1.5], [1e-7, 3e-7], [2.25, 2.25], [4503599627370495.5, 4503599627370496.5], [1791133400000.5, 1791133400000.25],
      ];
      for (const entry of edgeEntries()) {
        for (const [idleStartedAt, resumeAt] of pairs) {
          cases.push({ entry, args: { idleStartedAt, resumeAt, idleSegmentId: 's_idle', workSegmentId: 's_resume' } });
        }
      }
      const opening = makeEntry({ startedAt: T0 + 10 * MIN, segments: [seg('s_1', 'WORK', T0 + 10 * MIN, null)] });
      cases.push({ entry: opening, args: { idleStartedAt: T0 + 5 * MIN, resumeAt: T0 + 30 * MIN, idleSegmentId: 'i', workSegmentId: 'w' } });
      cases.push({ entry: opening, args: { idleStartedAt: T0 + 5 * MIN, resumeAt: T0 + 7 * MIN, idleSegmentId: 'i', workSegmentId: 'w' } });
      return cases;
    },
    random: (rng) => {
      const entry = genRunning(rng);
      const open = entry.segments.find((s) => s.endedAt === null);
      const idleStartedAt = near(rng, open ? open.startedAt : atFor(rng, entry));
      const resumeAt = rng.chance(0.12) ? near(rng, idleStartedAt) : clip(idleStartedAt + Math.abs(rng.pick([0, 1, MIN, 7 * MIN, HOUR, DAY, 30_000, 999])));
      return { entry, args: { idleStartedAt, resumeAt, idleSegmentId: id(rng), workSegmentId: id(rng) } };
    },
    call: ({ entry, args }: { entry: TimeEntry; args: Parameters<typeof applyIdleDiscard>[1] }) => applyIdleDiscard(entry, args),
  },
  {
    module,
    fn: 'recoverStaleEntry',
    edge: () => {
      const cases: Array<{ entry: TimeEntry; lastKnownActiveAt: number }> = [];
      for (const entry of edgeEntries()) {
        cases.push({ entry, lastKnownActiveAt: T0 + 12 * MIN }, { entry, lastKnownActiveAt: T0 - 10 * MIN }, { entry, lastKnownActiveAt: T0 }, { entry, lastKnownActiveAt: MAX_EXACT });
        for (const at of FRACTIONAL_ATS) cases.push({ entry, lastKnownActiveAt: at });
      }
      return cases;
    },
    random: (rng) => {
      const entry = genRunning(rng);
      return { entry, lastKnownActiveAt: atFor(rng, entry) };
    },
    call: ({ entry, lastKnownActiveAt }: { entry: TimeEntry; lastKnownActiveAt: number }) => recoverStaleEntry(entry, lastKnownActiveAt),
  },
  {
    module,
    fn: 'totalWorkedMs',
    edge: () => {
      const cases: Array<{ entry: TimeEntry; now?: number }> = [];
      for (const entry of edgeEntries()) {
        cases.push({ entry }, { entry, now: T0 + 7 * MIN }, { entry, now: T0 - 7 * MIN }, { entry, now: MAX_EXACT }, { entry, now: -MAX_EXACT });
        for (const now of FRACTIONAL_ATS) cases.push({ entry, now });
      }
      return cases;
    },
    random: (rng) => {
      const entry = genEntry(rng);
      return rng.chance(0.75) ? { entry, now: atFor(rng, entry) } : { entry };
    },
    call: ({ entry, now }: { entry: TimeEntry; now?: number }) => totalWorkedMs(entry, now),
  },
  {
    module,
    fn: 'totalIdleTrimmedMs',
    edge: () => edgeEntries().map((entry) => ({ entry })),
    random: (rng) => ({ entry: genEntry(rng) }),
    call: ({ entry }: { entry: TimeEntry }) => totalIdleTrimmedMs(entry),
  },
  {
    module,
    fn: 'validateEntry',
    edge: () => edgeEntries().map((entry) => ({ entry })),
    random: (rng) => ({ entry: genEntry(rng) }),
    call: ({ entry }: { entry: TimeEntry }) => validateEntry(entry),
  },
];
