import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';
import { loadLegacy } from '../legacyStubs/register';
import { asyncSpec } from './asyncSpec';
import { smallCount } from './seq';

const module = 'quit';

interface QuitModule {
  QuitCleanupRunner: new (deps: unknown) => { run(reason: string): Promise<void>; hasCompleted(): boolean; invalidate(): void };
  registerGracefulQuitHandler(opts: {
    app: { on(event: 'before-quit', listener: (event: { preventDefault(): void }) => void): unknown; quit(): void };
    runCleanup?: (reason: 'quit') => Promise<void>;
    hasCleanupCompleted?: () => boolean;
    markQuitting?: () => void;
  }): void;
}
const mod = await loadLegacy<QuitModule>('services/quitCleanup.ts');

// --- the runner ---------------------------------------------------------------------------------------

type Mode = 'deferred' | 'syncThrow' | 'value';
type Event =
  | { t: 'run'; reason: 'quit' | 'update' | 'shutdown' }
  | { t: 'finish'; op: number; how: 'resolve' | 'reject' }
  | { t: 'fire'; op: number }
  | { t: 'invalidate' };
type In = {
  timeoutMs?: number;
  flushLogs: boolean;
  activity: 'ok' | 'throw';
  getTimer: 'ok' | 'throw';
  prepare: 'deferred' | 'syncThrow';
  sync: 'deferred' | 'syncThrow';
  prefs: Mode;
  logs: Mode;
  events: Event[];
};

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await Promise.resolve();
}

async function run(input: In): Promise<unknown[]> {
  const trace: unknown[] = [];
  let nextOp = 0;
  /** The last op called and not yet followed by a timer arm. */
  let sinceArm: number | null = null;
  const deferred = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  const timers = new Map<number, { fn: () => void; live: boolean }>();
  const op = (name: string, extra: Record<string, unknown> = {}): number => {
    const id = nextOp++;
    sinceArm = id;
    trace.push({ e: 'op', id, op: name, ...extra });
    return id;
  };
  const settleLater = (id: number): Promise<void> => new Promise<void>((resolve, reject) => { deferred.set(id, { resolve, reject }); });
  const failure = (name: string): Error => new Error(`${name} failed`);
  /** getTimer() and prepareForQuit() are one step of the runner: one op id. */
  let timerStepId = 0;
  const timer = {
    prepareForQuit: (reason: string) => {
      const id = timerStepId;
      sinceArm = id;
      trace.push({ e: 'op', id, op: 'prepareForQuit', reason });
      if (input.prepare === 'syncThrow') { sinceArm = null; throw failure('prepareForQuit'); }
      return settleLater(id);
    },
    flushUnsynced: (limit?: number) => {
      const id = op('flushUnsynced', { limit: String(limit) });
      if (input.sync === 'syncThrow') { sinceArm = null; throw failure('flushUnsynced'); }
      return settleLater(id);
    },
  };
  const modeCall = (name: string, mode: Mode): unknown => {
    const id = op(name);
    if (mode === 'syncThrow') { sinceArm = null; throw failure(name); }
    return mode === 'deferred' ? settleLater(id) : undefined;
  };
  const logger = {
    debug: (message: string, meta: unknown) => { trace.push({ e: 'log', level: 'debug', message, meta }); },
    warn: (message: string, meta: unknown) => { trace.push({ e: 'log', level: 'warn', message, meta }); },
  };
  const runner = new mod.QuitCleanupRunner({
    getTimer: () => {
      const id = nextOp++;
      timerStepId = id;
      sinceArm = id;
      trace.push({ e: 'op', id, op: 'getTimer' });
      if (input.getTimer === 'throw') { sinceArm = null; throw failure('getTimer'); }
      return timer;
    },
    flushPartialActivity: () => {
      op('flushPartialActivity');
      sinceArm = null; // a synchronous step: no timer follows
      if (input.activity === 'throw') throw failure('flushPartialActivity');
    },
    flushPreferences: () => modeCall('flushPreferences', input.prefs),
    ...(input.flushLogs ? { flushLogs: () => modeCall('flushLogs', input.logs) } : {}),
    logger,
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    setTimeout: ((fn: () => void, ms: number) => {
      // Armed after the op that opened the step; with no `flushLogs` there is no op.
      const id = sinceArm !== null ? sinceArm : nextOp++;
      sinceArm = null;
      timers.set(id, { fn, live: true });
      trace.push({ e: 'arm', id, ms });
      return { id, unref() { return this; } };
    }) as unknown,
    clearTimeout: ((handle: { id: number }) => {
      const t = timers.get(handle.id);
      if (t) t.live = false;
      trace.push({ e: 'clear', id: handle.id });
    }) as unknown,
  });
  let pending: Promise<void> | null = null;
  const steps: unknown[] = [];
  for (const e of input.events) {
    let joined: boolean | null = null;
    switch (e.t) {
      case 'run': {
        const p = runner.run(e.reason);
        joined = pending !== null && p === pending;
        if (!joined) {
          pending = p;
          void p.finally(() => { if (pending === p) pending = null; });
        }
        break;
      }
      case 'finish': {
        const d = deferred.get(e.op);
        if (d) {
          deferred.delete(e.op);
          if (e.how === 'resolve') d.resolve();
          else d.reject(new Error('db busy'));
        }
        break;
      }
      case 'fire': {
        const t = timers.get(e.op);
        if (t?.live) {
          t.live = false;
          t.fn();
        }
        break;
      }
      case 'invalidate': runner.invalidate(); break;
    }
    await settle();
    steps.push({ joined, trace: trace.splice(0), completed: runner.hasCompleted() });
  }
  return steps;
}

function genIn(rng: Rng): In {
  const input: In = {
    flushLogs: rng.chance(0.8),
    activity: rng.chance(0.15) ? 'throw' : 'ok',
    getTimer: rng.chance(0.1) ? 'throw' : 'ok',
    prepare: rng.chance(0.1) ? 'syncThrow' : 'deferred',
    sync: rng.chance(0.1) ? 'syncThrow' : 'deferred',
    prefs: rng.weighted<Mode>([['deferred', 40], ['value', 45], ['syncThrow', 15]]),
    logs: rng.weighted<Mode>([['deferred', 40], ['value', 45], ['syncThrow', 15]]),
    events: [],
  };
  if (rng.chance(0.2)) input.timeoutMs = rng.pick([1000, 250, 0.5, 5000]);
  const total = smallCount(rng, 2, 40);
  for (let i = 0; i < total; i++) {
    const kind = rng.weighted<Event['t']>([['run', 14], ['finish', 40], ['fire', 22], ['invalidate', 6]]);
    switch (kind) {
      case 'run': input.events.push({ t: 'run', reason: rng.pick(['quit', 'update', 'shutdown'] as const) }); break;
      case 'finish': input.events.push({ t: 'finish', op: rng.int(0, 9), how: rng.chance(0.75) ? 'resolve' : 'reject' }); break;
      case 'fire': input.events.push({ t: 'fire', op: rng.int(0, 9) }); break;
      default: input.events.push({ t: 'invalidate' });
    }
  }
  return input;
}

/** Resolve the n-th deferred op of a plain scenario, one after another. */
function happyPath(over: Partial<In> = {}): In {
  const finish = (op: number): Event => ({ t: 'finish', op, how: 'resolve' });
  return { flushLogs: true, activity: 'ok', getTimer: 'ok', prepare: 'deferred', sync: 'deferred', prefs: 'value', logs: 'value', events: [{ t: 'run', reason: 'quit' }, finish(1), finish(2)], ...over };
}

function edge(): In[] {
  const run = (reason: 'quit' | 'update' | 'shutdown'): Event => ({ t: 'run', reason });
  const finish = (op: number, how: 'resolve' | 'reject' = 'resolve'): Event => ({ t: 'finish', op, how });
  const fire = (op: number): Event => ({ t: 'fire', op });
  // Op ids of one run: 0 activity, 1 timer step (getTimer + prepareForQuit), 2 sync, 3 preferences, 4 logs.
  return [
    happyPath(),
    happyPath({ events: [run('quit'), run('shutdown'), finish(1), run('update'), finish(2), run('quit')] }),
    happyPath({ events: [run('quit'), finish(1, 'reject'), run('quit')] }),
    happyPath({ events: [run('quit'), finish(1), finish(2), { t: 'invalidate' }, run('update'), finish(6), finish(7)] }),
    happyPath({ activity: 'throw' }),
    happyPath({ getTimer: 'throw' }),
    happyPath({ prepare: 'syncThrow' }),
    happyPath({ sync: 'syncThrow', events: [run('quit'), finish(1)] }),
    happyPath({ prefs: 'syncThrow', events: [run('quit'), finish(1), finish(2)] }),
    happyPath({ flushLogs: false, events: [run('quit'), finish(1), finish(2)] }),
    happyPath({ logs: 'syncThrow', events: [run('quit'), finish(1), finish(2)] }),
    // timeouts: each step abandoned in turn, and the late result still clears the timer
    happyPath({ events: [run('quit'), fire(1), fire(2), finish(1)] }),
    happyPath({ prefs: 'deferred', events: [run('quit'), finish(1), finish(2), fire(3), finish(3, 'reject'), fire(4), finish(4)] }),
    happyPath({ logs: 'deferred', events: [run('quit'), finish(1), finish(2), fire(4), finish(4, 'reject')] }),
    happyPath({ timeoutMs: 250, events: [run('quit'), fire(1), finish(1, 'reject'), finish(2), fire(2)] }),
    // firing a timer twice, or after it was cleared, does nothing
    happyPath({ events: [run('quit'), finish(1), fire(1), fire(2), fire(2), finish(2)] }),
    happyPath({ prefs: 'deferred', logs: 'deferred', events: [run('quit'), finish(1), finish(2), finish(3), finish(4), run('quit')] }),
  ];
}

const runnerSpec = await asyncSpec<In>({ module, fn: 'runner', edge, random: genIn, run });

// --- before-quit -----------------------------------------------------------------------------------------

const beforeQuitSpec: FnSpec<{ completed: boolean }> = {
  module,
  fn: 'beforeQuit',
  edge: () => [{ completed: false }, { completed: true }],
  random: (rng) => ({ completed: rng.chance(0.5) }),
  call: ({ completed }) => {
    const listeners = new Map<string, (event: { preventDefault(): void }) => void>();
    const calls: string[] = [];
    mod.registerGracefulQuitHandler({
      app: { on: (event, listener) => { listeners.set(event, listener); }, quit: () => { calls.push('quit'); } },
      runCleanup: () => { calls.push('runCleanup:quit'); return Promise.resolve(); },
      hasCleanupCompleted: () => completed,
      markQuitting: () => { calls.push('markQuitting'); },
    });
    listeners.get('before-quit')?.({ preventDefault: () => { calls.push('preventDefault'); } });
    return calls;
  },
};

export const specs: FnSpec<any>[] = [runnerSpec, beforeQuitSpec];
