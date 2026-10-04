import type { Rng } from '../prng';
import { DAY, MIN, OWNER, T0, base, entryText, seedRow } from './timerEdge';
import type { BusinessDaySpec, DeliverySpec, Op, Scenario, Setup } from './timerTypes';

const frac = (rng: Rng, x: number, p = 0.6): number => (rng.chance(p) ? x + rng.pick([0.5, 0.25, 0.75, 0.125, 0.2627, 0.0293, 1 / 3, 0.9999]) : x);

function genBusinessDay(rng: Rng, trueStart: number): BusinessDaySpec {
  const dayStart = trueStart - (((trueStart % DAY) + DAY) % DAY);
  return rng.weighted<BusinessDaySpec>([
    [{ kind: 'utc' }, 40],
    [{ kind: 'fixed', start: dayStart, end: dayStart + DAY }, 20],
    [{ kind: 'offset', offsetMs: rng.pick([19_800_000, -14_400_000, 0, 43_200_000, -39_600_000]) }, 30],
    [{ kind: 'none' }, 4],
    [{ kind: 'fixed', start: trueStart - 2 * MIN, end: trueStart + 30 * MIN }, 6],
  ]);
}

function genSeedRows(rng: Rng): Setup['seedRows'] {
  const rows: Setup['seedRows'] = [];
  const n = rng.int(1, 3);
  for (let i = 0; i < n; i++) {
    const id = `seed${i}`;
    const owned = rng.chance(0.4);
    const closedAt = rng.chance(0.5) ? T0 + rng.int(1, 30) * MIN + 0.5 : null;
    const entry: Record<string, unknown> = rng.chance(0.3) ? { userId: 'self' } : {};
    if (closedAt !== null) {
      entry.endedAt = closedAt;
      entry.closeReason = 'AGENT';
      entry.revision = 2;
      entry.segments = [{ id: `seg_${id}`, kind: 'WORK', startedAt: T0 + 0.25, endedAt: closedAt }];
    }
    rows.push(seedRow(id, {
      synced: closedAt !== null && rng.chance(0.3) ? 1 : 0,
      syncState: rng.pick(['pending_create', 'pending_update', 'synced', null] as const),
      ownerUserId: owned ? 'user-1' : null,
      ownerWorkspaceId: owned ? 'ws-1' : null,
      acknowledgedRevision: rng.chance(0.2) ? 2 : null,
      acknowledgedHash: rng.chance(0.2) ? 'f'.repeat(64) : null,
    }, entry));
  }
  return rows;
}

function genSetup(rng: Rng): Setup {
  const true0 = frac(rng, T0 + rng.int(-DAY, DAY), 0.8);
  const seeded = rng.chance(0.15);
  const setup = base({
    mono0: frac(rng, rng.int(1000, 900_000), 0.9),
    true0,
    skew: rng.weighted([[0, 70], [5 * MIN, 8], [-5 * MIN, 8], [12 * MIN, 5], [-90 * MIN, 5], [3 * MIN + 0.5, 4]]),
    perCall: rng.weighted([[0, 65], [0.013, 15], [0.5, 10], [1 / 3, 10]]),
    businessDay: genBusinessDay(rng, true0),
    mode: rng.weighted<Setup['mode']>([['VISIBLE', 45], ['SHADOW', 20], ['OFF', 35]]),
    idStart: rng.chance(0.9) ? 0 : rng.int(1, 5),
    legacySchema: seeded && rng.chance(0.5),
    claimLegacy: seeded && rng.chance(0.7),
    seedRows: seeded ? genSeedRows(rng) : [],
  });
  if (rng.chance(0.03)) setup.owner = null;
  return setup;
}

const guidOf = (rng: Rng): string | null => rng.pick(['task-a', 'task-a', 'task-b', 'task-c', null, '']);

function genSpec(rng: Rng): DeliverySpec {
  return rng.weighted<DeliverySpec>([
    [{ kind: 'ok', hash: 'agent' }, 30],
    [{ kind: 'ok', hash: 'server' }, 22],
    [{ kind: 'ok', hash: 'zeros' }, 10],
    [{ kind: 'ok', hash: 'zeros', disposition: rng.pick(['STALE', 'FINALIZED', 'CONFLICT', 'ALREADY_APPLIED']), revDelta: rng.pick([0, 0, 1, -1]) }, 8],
    [{ kind: 'ok', hash: rng.pick(['zeros', 'agent'] as const), correction: rng.pick(['CLOCK_CLAMP', 'LEASE_FINALIZED', 'SUPERSEDED']) }, 8],
    [{ kind: 'http', status: 404, body: '{"error":"not_found"}' }, 8],
    [{ kind: 'http', status: rng.pick([500, 503, 409, 400, 401]), body: '{"error":"x"}' }, 6],
    [{ kind: 'neterr' }, 6],
    [{ kind: 'malformed', variant: rng.int(0, 4) }, 4],
    [{ kind: 'ok', hash: 'short' }, 2],
  ]);
}

/** A generator step whose weight is the likelihood of that kind of op. */
type Gen = (rng: Rng, st: { now: number; day: { start: number; end: number } }) => Op;

const idleMs = (rng: Rng): number => rng.pick([0, 0, 1, 500, 59_999.5, MIN, 4 * MIN + 0.5, 15 * MIN, 90 * MIN, -1000, 0.001]);

const GENS: Array<[Gen, number]> = [
  [(r) => ({ op: 'start', guid: guidOf(r) }), 15],
  [() => ({ op: 'stop' }), 7],
  [() => ({ op: 'pause' }), 6],
  [() => ({ op: 'resume' }), 8],
  [(r, s) => ({ op: 'resumeFromIdle', at: s.now + r.pick([-5 * MIN, 0, 0, MIN, 20 * MIN]) }), 4],
  [(r) => ({ op: 'pauseForIdle', ms: idleMs(r) }), 6],
  [(r) => ({ op: 'pauseForPermission', ms: r.pick([0, 0, 6000, 7 * MIN, 0.5, 1e6]) }), 4],
  [(r) => ({ op: 'prepareForQuit', reason: r.pick(['quit', 'update', 'shutdown']) }), 2],
  [(r) => ({ op: 'prepareForAway', reason: r.pick(['suspend', 'lock']), ms: idleMs(r) }), 3],
  [(r, s) => ({ op: 'recover', at: s.now + r.pick([-30 * MIN, -MIN, 0, 3 * MIN]) }), 2],
  [() => ({ op: 'recoverAway' }), 2],
  [(r, s) => ({ op: 'finalize', entry: r.pick(['open', 'open', 'nope']), at: s.now + r.pick([-10 * MIN, -MIN, 0, MIN]) }), 3],
  [() => ({ op: 'heartbeat' }), 4],
  [(r) => ({ op: 'flush', limit: r.pick([null, null, 'inf', 1, 2, 0]) }), 5],
  [(r) => ({ op: 'deliver', i: r.int(0, 3), spec: genSpec(r) }), 32],
  [() => ({ op: 'drain' }), 2],
  [(r) => ({ op: 'guard', mode: r.pick(['allow', 'allow', 'deny', 'hold']) }), 4],
  [(r) => ({ op: 'releaseGuard', deny: r.chance(0.2) }), 3],
  [(r) => ({ op: 'noteServerTime', offset: r.pick([0, 0, 200, 10 * MIN, -10 * MIN, 5000, -5000]), rtt: r.pick([0, 250, 6000, 1.5]) }), 4],
  [(r) => ({ op: 'tracking', active: r.chance(0.5) }), 3],
  [(r) => ({ op: 'suspend', ms: r.pick([MIN, 9 * MIN, 5 * MIN + 0.5]) }), 2],
  [(r) => ({ op: 'jumpDevice', ms: r.pick([MIN, -MIN, 3 * 60 * MIN]) }), 1],
  [(r) => ({ op: 'mode', mode: r.pick(['OFF', 'SHADOW', 'VISIBLE']) }), 2],
  [(r, s) => ({ op: 'snapshot', mods: r.shuffle(['copy', 'copy', 'older', 'newer', 'closed', 'skip', 'otherUser']).slice(0, r.int(0, 3)), manual: r.chance(0.4), extraAuto: r.chance(0.4), window: s.day, serverTimeOffset: r.pick([MIN, 10 * MIN, 0, -MIN]) }), 4],
  [(r, s) => ({ op: 'listToday', at: s.now + r.pick([0, MIN, -MIN]) }), 2],
  [(r, s) => ({ op: 'workedByTask', at: r.chance(0.5) ? null : s.now }), 2],
  [(r, s) => ({ op: 'diagnostics', at: r.chance(0.5) ? null : s.now }), 1],
  [() => ({ op: 'dismissNotice' }), 1],
  [() => ({ op: 'recoveryNotice' }), 1],
  [(r) => ({ op: 'bind', owner: r.pick([OWNER, OWNER, { userId: 'user-2', workspaceId: 'ws-1' }, null]), claim: r.chance(0.3) }), 2],
  [(r) => ({ op: 'ids', set: r.int(0, 6) }), 1],
  [(r) => ({ op: 'listener', throws: r.chance(0.5) }), 1],
  [(r, s) => ({ op: 'beginMeeting', at: s.now + r.pick([0, MIN]) }), 1],
  [(r, s) => ({ op: 'endMeeting', at: s.now + r.pick([0, MIN]) }), 1],
  [(r, s) => ({ op: 'discardAway', start: s.now - r.pick([MIN, 10 * MIN]), resume: s.now + r.pick([0, 500]) }), 1],
  [(r, s) => ({
    op: 'sql',
    stmt: "INSERT OR REPLACE INTO timer_meta (key, value) VALUES ('ws-1:user-1:away_state', ?)",
    params: [JSON.stringify({ reason: r.pick(['suspend', 'lock']), entryId: r.pick(['ID00000001', 'ID00000004', 'ID00000007', 'other']), awayStartedAt: s.now + r.pick([-5 * MIN, 0, 3 * MIN, 0.5]), observedAt: s.now })],
  }), 2],
  [(r) => ({ op: 'sql', stmt: r.pick(["UPDATE timer_meta SET value = 'garbage' WHERE key LIKE '%recovery_notice'", "DELETE FROM timer_meta WHERE key LIKE '%liveness'", "UPDATE timer_meta SET value = '12abc' WHERE key LIKE '%liveness'"]), params: [] }), 1],
  [() => ({ op: 'lastLiveness' }), 1],
  [(r) => ({ op: 'isPendingCreate', id: r.pick(['ID00000001', 'ID00000004', 'nope']) }), 1],
  [() => ({ op: 'hasUnsynced' }), 1],
  [(r, s) => ({ op: 'burst', ops: Array.from({ length: r.int(2, 4) }, () => r.pick(BURSTABLE)(r, s)) }), 6],
];

const BURSTABLE: Gen[] = [
  (r) => ({ op: 'start', guid: guidOf(r) }),
  () => ({ op: 'stop' }),
  () => ({ op: 'pause' }),
  () => ({ op: 'resume' }),
  (r, s) => ({ op: 'resumeFromIdle', at: s.now + r.pick([0, MIN]) }),
  (r) => ({ op: 'pauseForIdle', ms: idleMs(r) }),
  (r) => ({ op: 'pauseForPermission', ms: r.pick([0, 6000]) }),
  (r) => ({ op: 'prepareForAway', reason: r.pick(['suspend', 'lock']), ms: idleMs(r) }),
  (r) => ({ op: 'prepareForQuit', reason: r.pick(['quit', 'update']) }),
  (r) => ({ op: 'releaseGuard', deny: r.chance(0.2) }),
  () => ({ op: 'releaseGuard', deny: false }),
  () => ({ op: 'heartbeat' }),
  () => ({ op: 'flush', limit: null }),
];

/** One seeded random scenario of 5-40 ops. */
export function randomScenario(rng: Rng, index: number): Scenario {
  const setup = genSetup(rng);
  const length = rng.int(5, 40);
  const st = { now: setup.true0 + setup.skew * 0, day: { start: setup.true0 - (((setup.true0 % DAY) + DAY) % DAY), end: 0 } };
  st.day.end = st.day.start + DAY;
  const ops: Op[] = [];
  for (let i = 0; i < length; i++) {
    if (rng.chance(0.28)) {
      const ms = frac(rng, rng.weighted([[rng.int(0, 2000), 40], [rng.pick([MIN, 2 * MIN, 5 * MIN]), 35], [rng.int(0, 20 * MIN), 25]]), 0.6);
      ops.push({ op: 'advance', ms });
      st.now += ms;
    }
    ops.push(rng.weighted(GENS.map(([gen, w]) => [gen, w] as const))(rng, st));
  }
  if (rng.chance(0.4)) ops.push({ op: 'drain' });
  return { name: `random-${index}`, setup, ops };
}

export { entryText };
