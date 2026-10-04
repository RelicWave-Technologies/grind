import { MIN, T0, base } from './timerEdge';
import type { Op, Scenario } from './timerTypes';

/**
 * Ops that run in ONE synchronous turn (`burst`): nothing, not even a microtask, runs between
 * them, so two calls can be suspended at once and resumed in the same checkpoint. Every
 * `await commitOpen()` / `await commitClosed()` yields one tick before the status is read, and
 * the other call's continuation runs in that tick: that order, and the clock reads it implies,
 * are what these scenarios pin.
 */
const start = (guid: string | null): Op => ({ op: 'start', guid });
const hold: Op = { op: 'guard', mode: 'hold' };
const allow: Op = { op: 'guard', mode: 'allow' };
const release = (deny = false): Op => ({ op: 'releaseGuard', deny });
const burst = (...ops: Op[]): Op => ({ op: 'burst', ops });
const adv = (ms: number): Op => ({ op: 'advance', ms });
const ok: Op = { op: 'deliver', i: 0, spec: { kind: 'ok', hash: 'agent' } };
const drain: Op = { op: 'drain' };
const ticking = { mono0: 123456.789012, true0: 1791133383891.2627, perCall: 0.5 };

export function burstScenarios(): Scenario[] {
  const sc = (name: string, ops: Op[], over: Parameters<typeof base>[0] = {}): Scenario => ({ name, setup: base(over), ops });
  return [
    // Both calls hold the guard; both are released in one turn; the network is pending.
    sc('burst-two-starts-released-together-both-return-the-last-status', [hold, start('a'), start('b'), burst(release(), release()), ok, ok, drain]),
    sc('burst-two-starts-released-together-ticking-clock', [hold, start('a'), start('b'), burst(release(), release()), drain], ticking),
    sc('burst-three-starts-a-b-a-released-together', [hold, start('a'), start('b'), start('a'), burst(release(), release(), release()), drain], { perCall: 0.25 }),
    sc('burst-start-then-denied-start', [hold, start('a'), start('b'), burst(release(), release(true)), drain]),
    sc('burst-two-resumes-released-together', [start('a'), { op: 'pause' }, hold, { op: 'resume' }, { op: 'resume' }, burst(release(), release()), drain], { perCall: 0.5 }),
    sc('burst-resume-and-start-released-together', [start('a'), { op: 'pause' }, hold, { op: 'resume' }, start('b'), burst(release(), release()), drain]),
    sc('burst-resume-from-idle-and-stop-in-one-turn', [start('a'), adv(MIN), { op: 'pauseForIdle', ms: 0 }, hold, { op: 'resumeFromIdle', at: T0 + 2 * MIN }, burst(release(), { op: 'stop' }), drain]),
    // No guard involved: the allow path still yields one tick, so these interleave too.
    sc('burst-allowed-starts-and-stop-in-one-turn', [allow, burst(start('a'), { op: 'stop' }, start('b'), { op: 'pause' }), drain]),
    sc('burst-start-pause-resume-quit-in-one-turn', [burst(start('a'), { op: 'pause' }, { op: 'resume' }, { op: 'prepareForQuit', reason: 'quit' }), drain], { perCall: 0.125 }),
    sc('burst-pause-for-permission-and-pause-for-idle-in-one-turn', [start('a'), burst({ op: 'pauseForPermission', ms: 0 }, { op: 'pauseForIdle', ms: 0 }, { op: 'pause' }, { op: 'resume' }), drain], { perCall: 0.5 }),
    sc('burst-away-between-two-starts', [hold, start('a'), start('b'), burst(release(), { op: 'prepareForAway', reason: 'lock', ms: 0 }, release()), drain]),
    sc('burst-quit-then-start-while-the-clear-is-pending', [start('a'), burst({ op: 'prepareForQuit', reason: 'quit' }, start('b')), drain], { perCall: 0.5 }),
    sc('burst-listener-failure-between-two-starts', [{ op: 'listener', throws: true }, hold, start('a'), start('b'), burst(release(), release()), { op: 'listener', throws: false }, drain]),
  ];
}
