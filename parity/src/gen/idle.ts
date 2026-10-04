import { computeIdleStart, shouldPromptIdle, type IdleInputs } from '../../../legacy/agent/src/main/services/idle/decide';
import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';
import { loadLegacy } from '../legacyStubs/register';
import { world } from '../legacyStubs/state';
import { asyncSpec } from './asyncSpec';
import { MIN, T0, maybeFrac } from './common';
import { clockStart, plain, smallCount } from './seq';

const module = 'idle';

// --- decide.ts -------------------------------------------------------------------

const idleSecs = (rng: Rng): number =>
  rng.weighted<() => number>([
    [() => rng.int(0, 900), 50],
    [() => rng.pick([0, 59, 60, 61, 299, 300, 301, 120, 999, -5, -1, 1e9]), 25],
    [() => maybeFrac(rng, rng.int(0, 600), 1), 15],
    [() => rng.pick([0.5, 1e-9, 299.9999999, 300.0000001]), 10],
  ])();

const shouldPromptSpec: FnSpec<IdleInputs> = {
  module,
  fn: 'shouldPromptIdle',
  edge: () => [
    { isRunning: true, idleSeconds: 301, thresholdSec: 300, prompting: false },
    { isRunning: true, idleSeconds: 300, thresholdSec: 300, prompting: false },
    { isRunning: true, idleSeconds: 120, thresholdSec: 300, prompting: false },
    { isRunning: false, idleSeconds: 999, thresholdSec: 300, prompting: false },
    { isRunning: true, idleSeconds: 999, thresholdSec: 300, prompting: true },
  ],
  random: (rng) => ({ isRunning: rng.chance(0.8), idleSeconds: idleSecs(rng), thresholdSec: idleSecs(rng), prompting: rng.chance(0.2) }),
  call: (i) => shouldPromptIdle(i),
};

type StartIn = { nowMs: number; idleSeconds: number };
const computeIdleStartSpec: FnSpec<StartIn> = {
  module,
  fn: 'computeIdleStart',
  edge: () => [
    { nowMs: 1_000_000, idleSeconds: 60 }, { nowMs: 1_000_000, idleSeconds: -5 }, { nowMs: 1791133383891.2627, idleSeconds: 300 },
    { nowMs: 0, idleSeconds: 0.5 }, { nowMs: T0, idleSeconds: 1e-9 }, { nowMs: 1e15, idleSeconds: 1e12 },
  ],
  random: (rng) => ({ nowMs: clockStart(rng), idleSeconds: idleSecs(rng) }),
  call: ({ nowMs, idleSeconds }) => plain(computeIdleStart(nowMs, idleSeconds)),
};

// --- IdleMonitor ------------------------------------------------------------------

type Outcome = 'accept' | 'reject' | 'throw';
type IdleEvent =
  | { t: 'tick'; now: number; idle: number; running: boolean; paused: boolean; prot: boolean; threshold: number; warning: number | null }
  | { t: 'resolveWarning'; now: number; result: Outcome }
  | { t: 'resolveIdle'; result: Outcome }
  | { t: 'noteActivity' }
  | { t: 'suspend' }
  | { t: 'resume' }
  | { t: 'resolve' }
  | { t: 'isPrompting' };
type IdleIn = { events: IdleEvent[] };

interface Monitor {
  tick(): Promise<void>;
  noteActivity(): void;
  suspend(): void;
  resume(): void;
  resolve(): void;
  isPrompting(): boolean;
}
interface MonitorModule {
  IdleMonitor: new (
    handlers: {
      onWarning: (info: { idleStartedAt: number; deadlineAt: number }) => Promise<boolean>;
      onWarningCancelled: () => void;
      onIdle: (idleStartedAt: number) => Promise<boolean>;
    },
    isProtected?: () => boolean,
  ) => Monitor;
}

const monitorModule = await loadLegacy<MonitorModule>('services/idle/monitor.ts');

/** Lets every pending promise continuation run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

interface Deferred {
  resolve: (v: boolean) => void;
  reject: (e: Error) => void;
}

function settleWith(d: Deferred | null, result: Outcome): void {
  if (!d) return;
  if (result === 'throw') d.reject(new Error('handler failed'));
  else d.resolve(result === 'accept');
}

async function runMonitor({ events }: IdleIn): Promise<unknown[]> {
  const trace: unknown[] = [];
  let pendingWarning: Deferred | null = null;
  let pendingIdle: Deferred | null = null;
  let prot = false;
  const monitor = new monitorModule.IdleMonitor(
    {
      onWarning: (info) => {
        trace.push({ e: 'warning', idleStartedAt: info.idleStartedAt, deadlineAt: info.deadlineAt });
        return new Promise<boolean>((resolve, reject) => { pendingWarning = { resolve, reject }; });
      },
      onWarningCancelled: () => { trace.push({ e: 'warningCancelled' }); },
      onIdle: (idleStartedAt) => {
        trace.push({ e: 'idle', idleStartedAt });
        return new Promise<boolean>((resolve, reject) => { pendingIdle = { resolve, reject }; });
      },
    },
    () => prot,
  );
  const internals = monitor as unknown as Record<string, unknown>;
  const realNow = Date.now;
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const steps: unknown[] = [];
  try {
    globalThis.setTimeout = ((_fn: unknown, ms?: number) => {
      trace.push({ e: 'arm', delay: ms });
      return { unref() { return this; } };
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = (() => { trace.push({ e: 'clear' }); }) as unknown as typeof clearTimeout;
    for (const e of events) {
      let ret: unknown = null;
      switch (e.t) {
        case 'tick': {
          Date.now = () => e.now;
          world.idleSeconds = e.idle;
          world.timerStatus = () => (e.running ? { state: 'RUNNING', paused: e.paused } : { state: 'IDLE' });
          world.idleThresholdSec = e.threshold;
          world.idleWarningSeconds = e.warning;
          prot = e.prot;
          void monitor.tick();
          break;
        }
        case 'resolveWarning': {
          Date.now = () => e.now;
          const d = pendingWarning;
          pendingWarning = null;
          settleWith(d, e.result);
          break;
        }
        case 'resolveIdle': {
          const d = pendingIdle;
          pendingIdle = null;
          settleWith(d, e.result);
          break;
        }
        case 'noteActivity': monitor.noteActivity(); break;
        case 'suspend': monitor.suspend(); break;
        case 'resume': monitor.resume(); break;
        case 'resolve': monitor.resolve(); break;
        case 'isPrompting': ret = monitor.isPrompting(); break;
      }
      await settle();
      steps.push({
        ret,
        effects: trace.splice(0),
        state: {
          phase: internals.phase,
          suspended: internals.suspended,
          ticking: internals.ticking,
          idleStartedAt: internals.idleStartedAt,
          warningTriggerSec: internals.warningTriggerSec,
          thresholdSec: internals.thresholdSec,
          deadlineAt: internals.deadlineAt,
          timerSet: internals.deadlineTimer !== null,
        },
      });
    }
  } finally {
    Date.now = realNow;
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
  }
  return steps;
}

function genIdleEvents(rng: Rng): IdleIn {
  const events: IdleEvent[] = [];
  const total = smallCount(rng, 2, 40);
  let now = clockStart(rng);
  let idle = 0;
  const threshold = rng.pick([10, 60, 300, 300, 600, 90.5, 7.25]);
  const warning = rng.weighted<number | null>([[null, 40], [3, 20], [30, 20], [rng.int(1, 120), 10], [threshold, 5], [threshold + 5, 2], [0, 3]]);
  const outcome = (): Outcome => rng.weighted<Outcome>([['accept', 70], ['reject', 14], ['throw', 16]]);
  let running = true;
  let paused = false;
  for (let i = 0; i < total; i++) {
    const kind = rng.weighted<IdleEvent['t']>([
      ['tick', 52], ['resolveWarning', 9], ['resolveIdle', 11], ['noteActivity', 6], ['suspend', 3], ['resume', 3], ['resolve', 3], ['isPrompting', 3],
    ]);
    if (kind === 'tick') {
      now += rng.weighted<number>([[1000, 30], [5000, 40], [rng.int(0, 20_000), 20], [0, 5], [maybeFrac(rng, rng.int(0, 9000), 1), 5]]);
      idle = rng.weighted<number>([
        [idle + Math.round(now > 0 ? 5 : 1), 50],
        [rng.int(0, Math.ceil(threshold + 20)), 25],
        [0, 12],
        [threshold - (warning ?? 0), 6],
        [threshold, 5],
        [maybeFrac(rng, rng.int(0, 60), 1), 2],
      ]);
      if (rng.chance(0.06)) running = !running;
      if (rng.chance(0.08)) paused = !paused;
      events.push({ t: 'tick', now, idle, running, paused, prot: rng.chance(0.04), threshold, warning });
    } else if (kind === 'resolveWarning') events.push({ t: 'resolveWarning', now: now + rng.int(0, 3000), result: outcome() });
    else if (kind === 'resolveIdle') events.push({ t: 'resolveIdle', result: outcome() });
    else events.push({ t: kind } as IdleEvent);
  }
  return { events };
}

function edgeIdle(): IdleIn[] {
  const tk = (now: number, idle: number, over: Partial<Extract<IdleEvent, { t: 'tick' }>> = {}): IdleEvent => ({
    t: 'tick', now, idle, running: true, paused: false, prot: false, threshold: 10, warning: null, ...over,
  });
  const NOW = 1_784_203_200_000;
  return [
    // direct idle pause when the warning is disabled
    { events: [tk(NOW, 10), { t: 'resolveIdle', result: 'accept' }, { t: 'isPrompting' }] },
    // one warning before the threshold, a second tick does nothing
    { events: [tk(NOW, 7, { warning: 3 }), { t: 'resolveWarning', now: NOW, result: 'accept' }, tk(NOW, 7, { warning: 3 }), { t: 'resolve' }] },
    // activity returns: warning dismissed
    { events: [tk(NOW, 7, { warning: 3 }), { t: 'resolveWarning', now: NOW, result: 'accept' }, tk(NOW, 0, { warning: 3 }), { t: 'isPrompting' }] },
    // tracked input dismisses the warning
    { events: [tk(NOW, 7, { warning: 3 }), { t: 'resolveWarning', now: NOW, result: 'accept' }, { t: 'noteActivity' }, { t: 'isPrompting' }] },
    // warning becomes the durable idle prompt at the deadline
    { events: [tk(NOW, 7, { warning: 3 }), { t: 'resolveWarning', now: NOW, result: 'accept' }, tk(NOW + 3000, 10, { warning: 3 }), { t: 'resolveIdle', result: 'accept' }, { t: 'isPrompting' }] },
    // a coordinator conflict: onIdle returns false, then retries
    { events: [tk(NOW, 10), { t: 'resolveIdle', result: 'reject' }, tk(NOW + 1000, 11, { paused: true }), { t: 'resolveIdle', result: 'accept' }, { t: 'isPrompting' }] },
    // never warns or pauses when not accruing
    { events: [tk(NOW, 20, { warning: 3, paused: true }), tk(NOW, 20, { warning: 3, running: false })] },
    // machine-away suspend clears the warning
    { events: [tk(NOW, 7, { warning: 3 }), { t: 'resolveWarning', now: NOW, result: 'accept' }, { t: 'suspend' }, tk(NOW, 7, { warning: 3 }), { t: 'isPrompting' }] },
    // warning handler declines / throws
    { events: [tk(NOW, 7, { warning: 3 }), { t: 'resolveWarning', now: NOW, result: 'reject' }, tk(NOW + 1000, 8, { warning: 3 }), { t: 'resolveWarning', now: NOW + 1000, result: 'throw' }] },
    // activity arrives while the warning handler is still pending, then it accepts: stale timer
    { events: [tk(NOW, 7, { warning: 3 }), { t: 'noteActivity' }, { t: 'resolveWarning', now: NOW + 500, result: 'accept' }, tk(NOW + 1000, 0, { warning: 3 })] },
    // resume while the idle prompt handler is pending, then it accepts
    { events: [tk(NOW, 12), { t: 'resume' }, { t: 'resolveIdle', result: 'accept' }, { t: 'isPrompting' }] },
    // deadline already passed when the handler resolves: delay clamps at 0
    { events: [tk(NOW, 7, { warning: 3 }), { t: 'resolveWarning', now: NOW + 99_999, result: 'accept' }] },
    // fractional idle seconds and clock
    { events: [tk(1791133383891.2627, 9.5, { threshold: 10.25, warning: 1.5 }), { t: 'resolveWarning', now: 1791133383891.7627, result: 'accept' }, tk(1791133384891.2627, 10.5, { threshold: 10.25, warning: 1.5 }), { t: 'resolveIdle', result: 'accept' }] },
    // protected
    { events: [tk(NOW, 20, { prot: true }), tk(NOW, 7, { warning: 3 }), { t: 'resolveWarning', now: NOW, result: 'accept' }, tk(NOW, 7, { warning: 3, prot: true })] },
  ];
}

const idleMonitorSpec = await asyncSpec<IdleIn>({ module, fn: 'idleMonitor', edge: edgeIdle, random: genIdleEvents, run: runMonitor });

export const specs: FnSpec<any>[] = [shouldPromptSpec, computeIdleStartSpec, idleMonitorSpec];
// MIN is part of the shared helpers other generators use; keep the import used.
void MIN;
