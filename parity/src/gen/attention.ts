import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';
import { loadLegacy } from '../legacyStubs/register';
import { asyncSpec } from './asyncSpec';
import { maybeFrac } from './common';
import { clockStart, smallCount } from './seq';
import {
  decidePromptGate,
  type PromptGateInput,
} from '../../../legacy/agent/src/main/services/promptReachability';

const module = 'attention';

// --- promptReachability -------------------------------------------------------------

const promptGateSpec: FnSpec<PromptGateInput> = {
  module,
  fn: 'decidePromptGate',
  edge: () => [
    { hasPrompt: false, sinceLastRestoreMs: null, windowMs: 12_000 },
    { hasPrompt: false, sinceLastRestoreMs: 5, windowMs: 12_000 },
    { hasPrompt: true, sinceLastRestoreMs: null, windowMs: 12_000 },
    { hasPrompt: true, sinceLastRestoreMs: 3_000, windowMs: 12_000 },
    { hasPrompt: true, sinceLastRestoreMs: 12_000, windowMs: 12_000 },
    { hasPrompt: true, sinceLastRestoreMs: 11_999, windowMs: 12_000 },
    { hasPrompt: true, sinceLastRestoreMs: 60_000, windowMs: 12_000 },
    { hasPrompt: true, sinceLastRestoreMs: -1, windowMs: 12_000 },
    { hasPrompt: true, sinceLastRestoreMs: 0, windowMs: 12_000 },
    { hasPrompt: true, sinceLastRestoreMs: 0, windowMs: 0 },
    { hasPrompt: true, sinceLastRestoreMs: 11_999.5, windowMs: 12_000 },
  ],
  random: (rng): PromptGateInput => ({
    hasPrompt: rng.chance(0.8),
    sinceLastRestoreMs: rng.weighted<number | null>([
      [null, 15], [rng.int(0, 30_000), 40], [rng.pick([0, 1, 11_999, 12_000, 12_001, -1, -5000]), 25], [maybeFrac(rng, rng.int(0, 20_000), 1), 15], [1e15, 2], [-1e15, 3],
    ]),
    windowMs: rng.weighted<number>([[12_000, 50], [rng.int(0, 60_000), 30], [0, 8], [maybeFrac(rng, 12_000, 1), 7], [-5, 3], [1e15, 2]]),
  }),
  call: (i) => decidePromptGate(i),
};

// --- the coordinator ------------------------------------------------------------------

type Resume = 'none' | 'flag' | 'asyncFlag' | 'never' | 'always' | 'throws' | 'asyncThrows';
type Target = 'current' | 'stale';
type ClearTarget = Target | 'none' | 'empty';
type Intent = 'START_TASK' | 'RESUME_ENTRY' | 'SETUP';

type Event =
  | { t: 'requestIdleWarning'; idleStartedAt: number; deadlineAt: number }
  | { t: 'requestIdle'; idleStartedAt: number }
  | { t: 'clearIdleWarning' }
  | { t: 'beginMachineAway' }
  | { t: 'requestAway'; larkTaskGuid: string | null; stoppedAt: number; reason: 'suspend' | 'lock' }
  | { t: 'requestPermission'; intent: Intent }
  | { t: 'yield'; target: Target; resume: Resume }
  | { t: 'restoreActive' }
  | { t: 'releaseUnreachable'; reason: string }
  | { t: 'clear'; target: ClearTarget }
  | { t: 'isPermissionActive' }
  | { t: 'fireReady' }
  | { t: 'tick' }
  | { t: 'flush' }
  | { t: 'setGranted'; value: boolean }
  | { t: 'setTopThrows'; value: boolean }
  | { t: 'setOnTop'; value: boolean };
type In = { logging: boolean; resumePollMs?: number; events: Event[] };

interface Prompt { kind: string; promptId?: string }
interface Coordinator {
  get(): Prompt;
  requestIdleWarning(info: { idleStartedAt: number; deadlineAt: number }): boolean;
  requestIdle(idleStartedAt: number): boolean;
  clearIdleWarning(): boolean;
  beginMachineAway(): void;
  requestAway(info: { larkTaskGuid: string | null; stoppedAt: number; reason: 'suspend' | 'lock' }): boolean;
  requestPermission(intent: Intent): Prompt;
  yieldPermissionToSystemSettings(promptId: string, opts?: { resumeWhen?: () => boolean | Promise<boolean> }): boolean;
  restoreActive(): boolean;
  releaseUnreachable(reason: string): boolean;
  clear(promptId?: string): boolean;
  isPermissionActive(): boolean;
  __resumeTickForTests(): void;
}
interface Module {
  createTrackingAttentionCoordinator(deps: unknown): Coordinator;
}

const mod = await loadLegacy<Module>('services/trackingAttention.ts');

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

async function runCoordinator({ logging, resumePollMs, events }: In): Promise<unknown[]> {
  const trace: unknown[] = [];
  let next = 0;
  let onTop = true;
  let throwOnTop = false;
  let granted = false;
  const ready: { listener: (() => void) | null } = { listener: null };
  const host = {
    place: (spec: unknown) => { trace.push({ e: 'place', spec }); },
    keep: () => { onTop = true; trace.push({ e: 'keep' }); },
    release: () => { trace.push({ e: 'release' }); },
    activate: () => { onTop = true; trace.push({ e: 'activate' }); },
    onTop: () => {
      if (throwOnTop) {
        trace.push({ e: 'onTop', value: null });
        throw new Error('host exploded');
      }
      trace.push({ e: 'onTop', value: onTop });
      return onTop;
    },
    lower: () => { onTop = false; trace.push({ e: 'lower' }); },
    hide: () => { trace.push({ e: 'hide' }); },
    publish: (prompt: unknown) => { trace.push({ e: 'publish', prompt }); },
    onReady: (listener: () => void) => { ready.listener = listener; trace.push({ e: 'onReady' }); },
    isReady: () => true,
  };
  const entry = (level: string) => (message: string, meta?: unknown) => { trace.push({ e: 'log', entry: { level, message, meta } }); };
  const coordinator = mod.createTrackingAttentionCoordinator({
    id: () => { const value = `prompt-${++next}`; trace.push({ e: 'id', value }); return value; },
    host,
    ...(resumePollMs === undefined ? {} : { resumePollMs }),
    ...(logging ? { logger: { info: entry('info'), warn: entry('warn') } } : {}),
    setInterval: ((_fn: unknown, ms: number) => { trace.push({ e: 'setInterval', ms }); return { unref() { return this; } }; }) as unknown,
    clearInterval: (() => { trace.push({ e: 'clearInterval' }); }) as unknown,
  });
  const currentId = (): string => coordinator.get().promptId ?? 'no-prompt';
  const idOf = (target: Target): string => (target === 'stale' ? 'older-prompt' : currentId());
  const predicate = (kind: Resume): (() => boolean | Promise<boolean>) | undefined => {
    switch (kind) {
      case 'none': return undefined;
      case 'flag': return () => granted;
      case 'asyncFlag': return async () => granted;
      case 'never': return () => false;
      case 'always': return () => true;
      case 'throws': return () => { throw new Error('probe failed'); };
      case 'asyncThrows': return async () => { throw new Error('probe failed'); };
    }
  };
  const steps: unknown[] = [];
  for (const e of events) {
    let ret: unknown = null;
    switch (e.t) {
      case 'requestIdleWarning': ret = coordinator.requestIdleWarning({ idleStartedAt: e.idleStartedAt, deadlineAt: e.deadlineAt }); break;
      case 'requestIdle': ret = coordinator.requestIdle(e.idleStartedAt); break;
      case 'clearIdleWarning': ret = coordinator.clearIdleWarning(); break;
      case 'beginMachineAway': coordinator.beginMachineAway(); break;
      case 'requestAway': ret = coordinator.requestAway({ larkTaskGuid: e.larkTaskGuid, stoppedAt: e.stoppedAt, reason: e.reason }); break;
      case 'requestPermission': ret = coordinator.requestPermission(e.intent); break;
      case 'yield': {
        const resumeWhen = predicate(e.resume);
        ret = resumeWhen === undefined
          ? coordinator.yieldPermissionToSystemSettings(idOf(e.target))
          : coordinator.yieldPermissionToSystemSettings(idOf(e.target), { resumeWhen });
        break;
      }
      case 'restoreActive': ret = coordinator.restoreActive(); break;
      case 'releaseUnreachable': ret = coordinator.releaseUnreachable(e.reason); break;
      case 'clear':
        ret = e.target === 'none' ? coordinator.clear() : e.target === 'empty' ? coordinator.clear('') : coordinator.clear(idOf(e.target));
        break;
      case 'isPermissionActive': ret = coordinator.isPermissionActive(); break;
      case 'fireReady': ready.listener?.(); break;
      case 'tick': coordinator.__resumeTickForTests(); break;
      case 'flush': await settle(); break;
      case 'setGranted': granted = e.value; break;
      case 'setTopThrows': throwOnTop = e.value; break;
      case 'setOnTop': onTop = e.value; break;
    }
    steps.push({ ret, calls: trace.splice(0), prompt: coordinator.get() });
  }
  await settle();
  return steps;
}

const RESUMES: Resume[] = ['none', 'flag', 'asyncFlag', 'never', 'always', 'throws', 'asyncThrows'];

function genEvents(rng: Rng): In {
  const total = smallCount(rng, 2, 45);
  const events: Event[] = [];
  const now = clockStart(rng);
  for (let i = 0; i < total; i++) {
    const kind = rng.weighted<Event['t']>([
      ['requestIdleWarning', 6], ['requestIdle', 9], ['clearIdleWarning', 3], ['beginMachineAway', 4], ['requestAway', 7], ['requestPermission', 12],
      ['yield', 12], ['restoreActive', 6], ['releaseUnreachable', 4], ['clear', 7], ['isPermissionActive', 2], ['fireReady', 3], ['tick', 14], ['flush', 10],
      ['setGranted', 4], ['setTopThrows', 2], ['setOnTop', 2],
    ]);
    switch (kind) {
      case 'requestIdleWarning': events.push({ t: kind, idleStartedAt: maybeFrac(rng, now + rng.int(-9000, 9000), 0.3), deadlineAt: maybeFrac(rng, now + rng.int(0, 300_000), 0.3) }); break;
      case 'requestIdle': events.push({ t: kind, idleStartedAt: maybeFrac(rng, now + rng.int(-9000, 9000), 0.3) }); break;
      case 'requestAway': events.push({ t: kind, larkTaskGuid: rng.chance(0.5) ? null : rng.pick(['task-1', 'task-2', '']), stoppedAt: maybeFrac(rng, now + rng.int(-9000, 9000), 0.3), reason: rng.pick(['suspend', 'lock'] as const) }); break;
      case 'requestPermission': events.push({ t: kind, intent: rng.pick(['START_TASK', 'RESUME_ENTRY', 'SETUP'] as const) }); break;
      case 'yield': events.push({ t: kind, target: rng.chance(0.85) ? 'current' : 'stale', resume: rng.pick(RESUMES) }); break;
      case 'releaseUnreachable': events.push({ t: kind, reason: rng.pick(['main_window_requested_twice', 'whatever', '']) }); break;
      case 'clear': events.push({ t: kind, target: rng.weighted<ClearTarget>([['current', 40], ['none', 35], ['stale', 15], ['empty', 10]]) }); break;
      case 'setGranted': case 'setTopThrows': case 'setOnTop': events.push({ t: kind, value: rng.chance(0.6) }); break;
      default: events.push({ t: kind } as Event);
    }
  }
  return { logging: rng.chance(0.85), ...(rng.chance(0.1) ? { resumePollMs: rng.pick([500, 2000, 0.5]) } : {}), events };
}

function edge(): In[] {
  const warn: Event = { t: 'requestIdleWarning', idleStartedAt: 100, deadlineAt: 200 };
  const perm = (intent: Intent = 'SETUP'): Event => ({ t: 'requestPermission', intent });
  const yieldCur = (resume: Resume): Event => ({ t: 'yield', target: 'current', resume });
  const away: Event = { t: 'requestAway', larkTaskGuid: null, stoppedAt: 1000, reason: 'suspend' };
  const base = (events: Event[], logging = true): In => ({ logging, events });
  return [
    base([warn, { t: 'requestIdle', idleStartedAt: 100 }]),
    base([warn, { t: 'clearIdleWarning' }, { t: 'clearIdleWarning' }]),
    base([{ t: 'requestIdle', idleStartedAt: 100 }, perm('START_TASK'), { t: 'requestIdle', idleStartedAt: 200 }, { t: 'requestAway', larkTaskGuid: 'task-1', stoppedAt: 300, reason: 'lock' }]),
    base([{ t: 'requestIdle', idleStartedAt: 100 }, { t: 'beginMachineAway' }, { t: 'requestAway', larkTaskGuid: null, stoppedAt: 200, reason: 'suspend' }]),
    base([perm('SETUP'), yieldCur('none'), perm('RESUME_ENTRY')]),
    base([perm('START_TASK'), { t: 'clear', target: 'stale' }, { t: 'yield', target: 'stale', resume: 'none' }]),
    base([{ t: 'requestIdle', idleStartedAt: 100 }, { t: 'fireReady' }, { t: 'clear', target: 'current' }]),
    base([perm(), yieldCur('none'), { t: 'tick' }, { t: 'tick' }]),
    base([perm(), yieldCur('flag'), { t: 'tick' }, { t: 'tick' }, { t: 'flush' }, { t: 'setGranted', value: true }, { t: 'tick' }, { t: 'tick' }, { t: 'flush' }]),
    base([perm(), yieldCur('throws'), { t: 'tick' }, { t: 'tick' }, { t: 'flush' }, { t: 'tick' }, { t: 'tick' }, { t: 'flush' }]),
    base([away, { t: 'releaseUnreachable', reason: 'main_window_requested_twice' }]),
    base([{ t: 'releaseUnreachable', reason: 'whatever' }]),
    base([perm(), { t: 'releaseUnreachable', reason: 'x' }, { t: 'requestIdle', idleStartedAt: 500 }]),
    base([perm(), yieldCur('always'), { t: 'releaseUnreachable', reason: 'x' }, { t: 'tick' }, { t: 'flush' }]),
    // a release lands between the poll and its answer: the answer is ignored
    base([perm(), yieldCur('always'), { t: 'tick' }, { t: 'releaseUnreachable', reason: 'x' }, { t: 'flush' }]),
    // a second yield replaces the predicate while the first check is in flight
    base([perm(), yieldCur('always'), { t: 'tick' }, perm('START_TASK'), yieldCur('never'), { t: 'flush' }, { t: 'tick' }, { t: 'flush' }]),
    base([{ t: 'requestIdle', idleStartedAt: 100 }, { t: 'restoreActive' }, { t: 'setOnTop', value: false }, { t: 'restoreActive' }]),
    base([{ t: 'restoreActive' }]),
    // no logger: onTop is never consulted
    base([{ t: 'requestIdle', idleStartedAt: 100 }, { t: 'restoreActive' }, { t: 'clear', target: 'none' }], false),
    // onTop throws: believed false
    base([{ t: 'setTopThrows', value: true }, { t: 'requestIdle', idleStartedAt: 100 }, { t: 'restoreActive' }, { t: 'releaseUnreachable', reason: 'r' }]),
    base([away, { t: 'clear', target: 'empty' }, { t: 'clear', target: 'current' }]),
    base([perm(), yieldCur('flag'), { t: 'setGranted', value: true }, { t: 'tick' }, { t: 'tick' }, { t: 'flush' }, { t: 'restoreActive' }]),
  ];
}

const coordinatorSpec = await asyncSpec<In>({ module, fn: 'coordinator', edge, random: genEvents, run: runCoordinator });

export const specs: FnSpec<any>[] = [promptGateSpec, coordinatorSpec];
