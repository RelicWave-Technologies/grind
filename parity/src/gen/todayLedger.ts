import { createHash } from 'node:crypto';
import { canonicalTimerEntryPayload, reconcileTodayLedger, type TimeEntry } from '@grind/core';
import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';
import { MAX_EXACT, MIN, T0, clip, genEntry, makeEntry, near, seg, ts } from './common';

type Input = Parameters<typeof reconcileTodayLedger>[0];
type Local = Input['local'][number];
type Server = Input['server'][number];

const sha = (payload: string): string => createHash('sha256').update(payload).digest('hex');

function server(entry: TimeEntry, effective: TimeEntry = entry, hash?: string): Server {
  const canonicalPayload = canonicalTimerEntryPayload(entry);
  return { entry: effective, canonicalPayload, canonicalHash: hash ?? sha(canonicalPayload) };
}

/** Port of the `entry` helper in todayLedger.test.ts. */
function entry(id: string, revision: number, start: number, end: number | null, source: TimeEntry['source'] = 'AUTO'): TimeEntry {
  return {
    id,
    clientUuid: `client-${id}`,
    userId: 'user-1',
    larkTaskGuid: null,
    source,
    revision,
    startedAt: start,
    endedAt: end,
    pauseReason: null,
    closeReason: end === null ? null : 'AGENT',
    segments: [{ id: `segment-${id}`, kind: 'WORK', startedAt: start, endedAt: end }],
  };
}

const H = 60 * 60_000;

const edgeInputs = (): Input[] => {
  const tracked = entry('tracked', 1, 0, 60_000);
  const approved = entry('manual', 0, 30_000, 90_000, 'MANUAL');
  const confirmed = entry('confirmed', 2, 0, 4.5 * H);
  const pending = entry('pending', 1, 4.5 * H, 5 * H);
  const a = entry('a', 1, 0, 60_000);
  const b = entry('b', 1, 30_000, 90_000);
  const sameLocal = entry('same', 2, 0, 60_000);
  const sameServer = entry('same', 1, 0, 30_000);
  const canonicalOpen = entry('open', 1, 0, null);
  const capped = entry('open', 1, 0, 60_000);
  const active = entry('active', 1, 0, null);
  const activeCapped = entry('active', 1, 0, 60_000);
  const localCorrected = entry('corrected', 2, 0, 80_000);
  const corrected = entry('corrected', 2, 0, 60_000);
  const correctedServer = server(corrected);
  const w = { windowStart: 0, windowEnd: 100_000, now: 100_000 };
  return [
    { local: [{ entry: tracked, syncState: 'synced' }], server: [server(tracked), server(approved)], ...w },
    { local: [{ entry: confirmed, syncState: 'synced' }, { entry: pending, syncState: 'pending_create' }], server: [server(confirmed)], windowStart: 0, windowEnd: 24 * H, now: 5 * H },
    { local: [{ entry: confirmed, syncState: 'synced' }, { entry: pending, syncState: 'synced' }], server: [server(confirmed), server(pending)], windowStart: 0, windowEnd: 24 * H, now: 5 * H },
    { local: [{ entry: a, syncState: 'pending_create' }], server: [server(b)], ...w },
    { local: [{ entry: sameLocal, syncState: 'pending_update' }], server: [server(sameServer)], ...w },
    { local: [{ entry: canonicalOpen, syncState: 'synced' }], server: [server(canonicalOpen, capped)], ...w },
    { local: [{ entry: active, syncState: 'synced' }], server: [server(active, activeCapped)], activeLocalEntryId: active.id, windowStart: 0, windowEnd: 200_000, now: 120_000 },
    { local: [{ entry: localCorrected, syncState: 'synced', acknowledgedRevision: 2, acknowledgedHash: correctedServer.canonicalHash }], server: [correctedServer], ...w },
    // fractional timestamps, as the real agent stores them
    { local: [{ entry: entry('r1', 3, 1791133383891.2627, 1791133448770.0293), syncState: 'pending_update' }], server: [server(entry('r1', 2, 1791133383891.2627, 1791133430180.8308))], windowStart: 1791100000000.5, windowEnd: 1791200000000.25, now: 1791133436609.776 },
    { local: [{ entry: entry('r2', 1, 1791133383891.2627, null), syncState: 'synced' }, { entry: entry('r3', 1, 1791133400000.1, 1791133450000.3), syncState: 'synced' }], server: [], windowStart: 0, windowEnd: 1791133500000.7, now: 1791133436609.776 },
    // sums whose result depends on the order they are added in
    { local: [{ entry: entry('s1', 1, 0.1, 0.30000000000000004), syncState: 'synced' }, { entry: entry('s2', 1, 0.5, 0.7000000000000001), syncState: 'synced' }, { entry: entry('s3', 1, 1e16, 1e16 + 2), syncState: 'synced' }], server: [], windowStart: 0, windowEnd: 2e16, now: 1e16 },
    { local: [{ entry: entry('big', 1, 4503599627370495.5, 4503599627370496.5), syncState: 'synced' }, { entry: entry('big2', 1, 1e-7, 3e-7), syncState: 'synced' }], server: [], windowStart: -1e-7, windowEnd: 9e15, now: 1 },
    // beyond the ported tests
    { local: [], server: [], ...w },
    { local: [{ entry: tracked, syncState: 'synced' }], server: [], ...w },
    { local: [{ entry: tracked, syncState: 'pending_update' }, { entry: a, syncState: 'pending_create' }], server: [], ...w },
    { local: [{ entry: tracked, syncState: 'synced', acknowledgedRevision: null, acknowledgedHash: null }], server: [server(entry('tracked', 1, 0, 61_000))], activeLocalEntryId: null, ...w },
    { local: [{ entry: tracked, syncState: 'synced' }], server: [server(entry('tracked', 3, 0, 60_000))], ...w },
    { local: [{ entry: entry('tracked', 3, 0, 60_000), syncState: 'synced' }], server: [server(tracked)], ...w },
    { local: [{ entry: entry('x', 1, 0, 60_000), syncState: 'synced' }], server: [server({ ...entry('y', 1, 0, 60_000), clientUuid: 'client-x' })], ...w },
    { local: [{ entry: tracked, syncState: 'synced' }], server: [server(tracked), server(entry('tracked', 1, 5, 60_000))], ...w },
    { local: [{ entry: tracked, syncState: 'synced' }], server: [server(tracked)], windowStart: 100_000, windowEnd: 0, now: 50_000 },
    { local: [{ entry: tracked, syncState: 'synced' }], server: [server(tracked)], windowStart: -MAX_EXACT, windowEnd: MAX_EXACT, now: MAX_EXACT },
    { local: [{ entry: entry('ties-b', 1, 5, 6), syncState: 'synced' }, { entry: entry('ties-B', 1, 5, 6), syncState: 'synced' }, { entry: entry('ties-a', 1, 5, 6), syncState: 'synced' }], server: [], windowStart: 0, windowEnd: 10, now: 10 },
  ];
};

function variant(rng: Rng, base: TimeEntry): TimeEntry {
  const v = rng.int(0, 7);
  const segs = base.segments.map((s) => ({ ...s }));
  switch (v) {
    case 0: return { ...base, revision: base.revision + 1 };
    case 1: return { ...base, revision: Math.max(0, base.revision - 1) };
    case 2: { // same revision, different payload
      const last = segs[segs.length - 1];
      if (last) last.endedAt = last.endedAt === null ? last.startedAt + MIN : null;
      return { ...base, segments: segs };
    }
    case 3: return { ...base, endedAt: base.endedAt === null ? base.startedAt : null };
    case 4: return { ...base, closeReason: base.closeReason === 'AGENT' ? 'AGENT_RECOVERY' : 'AGENT' };
    default: return base;
  }
}

function capOpen(entryValue: TimeEntry, at: number): TimeEntry {
  return { ...entryValue, segments: entryValue.segments.map((s) => (s.endedAt === null ? { ...s, endedAt: Math.max(at, s.startedAt) } : s)) };
}

function logical(rng: Rng, k: number): TimeEntry {
  const base = genEntry(rng, rng.chance(0.85) ? 'valid' : 'sloppy');
  const t = rng.chance(0.5) ? ts(rng) : T0 + rng.int(0, 10) * MIN;
  const shift = base.segments.length ? t - base.segments[0]!.startedAt : 0;
  const segments = base.segments.slice(0, 3).map((s) => ({ ...s, startedAt: clip(s.startedAt + shift), endedAt: s.endedAt === null ? null : clip(s.endedAt + shift) }));
  return makeEntry({
    id: `L${k}`,
    clientUuid: `C${k}`,
    userId: 'u',
    larkTaskGuid: base.larkTaskGuid,
    source: base.source,
    revision: rng.int(0, 4),
    startedAt: segments[0]?.startedAt ?? t,
    endedAt: base.endedAt === null ? null : clip(base.endedAt + shift),
    pauseReason: base.pauseReason,
    closeReason: base.closeReason,
    segments,
  });
}

function randomInput(rng: Rng): Input {
  const count = rng.weighted([[1, 30], [2, 40], [3, 22], [4, 8]] as const);
  const logicals = Array.from({ length: count }, (_, k) => logical(rng, k));
  const local: Local[] = [];
  const serverEntries: Server[] = [];
  for (const base of logicals) {
    const hasLocal = rng.chance(0.8);
    const hasServer = rng.chance(0.7);
    const localEntry = hasLocal ? variant(rng, base) : base;
    const serverCanonical = variant(rng, base);
    if (hasLocal) {
      const item: Local = { entry: localEntry, syncState: rng.pick(['pending_create', 'pending_update', 'synced', 'synced']) };
      if (hasServer && rng.chance(0.35)) {
        item.acknowledgedRevision = rng.chance(0.85) ? serverCanonical.revision : serverCanonical.revision + 1;
        item.acknowledgedHash = rng.chance(0.85) ? sha(canonicalTimerEntryPayload(serverCanonical)) : sha('other');
      } else if (rng.chance(0.1)) {
        item.acknowledgedRevision = null;
        item.acknowledgedHash = null;
      }
      local.push(item);
    }
    if (hasServer) {
      const keyed = rng.chance(0.12) ? { ...serverCanonical, id: `S${base.id}` } : serverCanonical;
      const effective = rng.chance(0.3) ? capOpen(keyed, near(rng, keyed.startedAt)) : keyed;
      serverEntries.push(server(keyed, effective, rng.chance(0.05) ? 'deadbeef' : undefined));
      if (rng.chance(0.06)) serverEntries.push(server({ ...keyed, revision: keyed.revision + 1 }));
    }
  }
  const starts = logicals.map((e) => e.startedAt);
  const lo = Math.min(...starts);
  const hi = Math.max(...logicals.map((e) => e.endedAt ?? e.segments[e.segments.length - 1]?.endedAt ?? e.startedAt));
  const windowStart = rng.chance(0.2) ? ts(rng) : near(rng, lo);
  const windowEnd = rng.chance(0.1) ? near(rng, windowStart) : near(rng, hi + 5 * MIN);
  const input: Input = {
    local: rng.chance(0.2) ? rng.shuffle(local) : local,
    server: rng.chance(0.2) ? rng.shuffle(serverEntries) : serverEntries,
    windowStart,
    windowEnd,
    now: rng.chance(0.8) ? near(rng, windowEnd) : ts(rng),
  };
  const activeMode = rng.int(0, 3);
  if (activeMode === 1) input.activeLocalEntryId = null;
  if (activeMode === 2 && local.length) input.activeLocalEntryId = rng.pick(local).entry.id;
  if (activeMode === 3) input.activeLocalEntryId = 'nobody';
  return input;
}

export const specs: FnSpec<Input>[] = [
  {
    module: 'todayLedger',
    fn: 'reconcileTodayLedger',
    edge: edgeInputs,
    random: randomInput,
    call: (input) => reconcileTodayLedger(input),
  },
];
