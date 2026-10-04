import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';
import { loadLegacyFresh } from '../legacyStubs/register';
import { world } from '../legacyStubs/state';
import { asyncSpec } from './asyncSpec';
import { T0, maybeFrac } from './common';
import { smallCount } from './seq';

const module = 'readiness';

type ScreenStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';
type Health = 'ok' | 'no-permission' | 'empty' | 'error' | 'unknown';
type Platform = 'darwin' | 'win32' | 'linux';
interface Ax { trusted: boolean; ready: boolean; recording: boolean; capturing: boolean; hookRunning: boolean; lastHookError: string | null }

const STATUSES: ScreenStatus[] = ['granted', 'denied', 'restricted', 'not-determined', 'unknown'];
const HEALTHS: Health[] = ['ok', 'no-permission', 'empty', 'error', 'unknown'];

interface Inspection {
  readiness: { blockingCapabilities: string[] };
  permissions: { screen: { status: string; health: string } };
}
interface Service {
  inspect(opts?: { verifyScreen?: boolean }): Promise<unknown>;
  assertCanAccrue(): Promise<void>;
  requestScreenAccess(): Promise<unknown>;
  noteScreenHealth(health: Health): void;
  invalidateScreenProbe(): void;
}
interface ReadinessModule {
  createTrackingReadinessService(deps: unknown): Service;
  isInconclusiveScreenCapture(inspection: Inspection, idleState: string): boolean;
}

// --- isInconclusiveScreenCapture (stateless) --------------------------------------------------------

const mod = await loadLegacyFresh<ReadinessModule>('services/trackingReadiness.ts');

type InconclusiveIn = { blocking: string[]; status: ScreenStatus; health: Health; idle: 'active' | 'idle' | 'locked' | 'unknown' };

const inconclusiveSpec: FnSpec<InconclusiveIn> = {
  module,
  fn: 'isInconclusiveScreenCapture',
  edge: () => [
    { blocking: ['SCREEN_RECORDING'], status: 'granted', health: 'empty', idle: 'idle' },
    { blocking: ['SCREEN_RECORDING'], status: 'granted', health: 'empty', idle: 'active' },
    { blocking: ['SCREEN_RECORDING', 'ACCESSIBILITY'], status: 'granted', health: 'empty', idle: 'idle' },
    { blocking: ['SCREEN_RECORDING'], status: 'denied', health: 'empty', idle: 'idle' },
    { blocking: ['ACCESSIBILITY'], status: 'granted', health: 'empty', idle: 'locked' },
    { blocking: [], status: 'granted', health: 'empty', idle: 'unknown' },
    { blocking: ['SCREEN_RECORDING'], status: 'granted', health: 'error', idle: 'idle' },
  ],
  random: (rng) => ({
    blocking: rng.pick([['SCREEN_RECORDING'], ['SCREEN_RECORDING'], ['ACCESSIBILITY'], ['SCREEN_RECORDING', 'ACCESSIBILITY'], ['ACCESSIBILITY', 'SCREEN_RECORDING'], []]),
    status: rng.weighted<ScreenStatus>([['granted', 60], ['denied', 15], ['restricted', 8], ['not-determined', 9], ['unknown', 8]]),
    health: rng.weighted<Health>([['empty', 50], ['ok', 15], ['error', 15], ['no-permission', 10], ['unknown', 10]]),
    idle: rng.pick(['active', 'idle', 'locked', 'unknown'] as const),
  }),
  call: ({ blocking, status, health, idle }) =>
    mod.isInconclusiveScreenCapture({ readiness: { blockingCapabilities: blocking }, permissions: { screen: { status, health } } }, idle),
};

// --- the service -------------------------------------------------------------------------------------

type Event =
  | { t: 'set'; platform?: Platform; screenStatus?: ScreenStatus; screenHealth?: Health; accessibility?: Partial<Ax>; now?: number }
  | { t: 'inspect'; verify: boolean }
  | { t: 'assert' }
  | { t: 'requestAccess' }
  | { t: 'resolveProbe'; probe: number; health: Health | 'throw' }
  | { t: 'noteHealth'; health: Health }
  | { t: 'invalidate' };
type In = { platform: Platform; screenStatus: ScreenStatus; screenHealth: Health; accessibility: Ax; now: number; events: Event[] };

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

async function run(input: In): Promise<unknown[]> {
  const fresh = await loadLegacyFresh<ReadinessModule>('services/trackingReadiness.ts');
  const w = { platform: input.platform, screenStatus: input.screenStatus, screenHealth: input.screenHealth, accessibility: { ...input.accessibility }, now: input.now };
  const probes: Array<{ resolve: (h: Health) => void; reject: (e: Error) => void }> = [];
  const current: Service = fresh.createTrackingReadinessService({
    // Read on every inspect, like `deps.platform` of the real service.
    get platform() { return w.platform; },
    now: () => w.now,
    screenStatus: () => w.screenStatus,
    screenHealth: () => w.screenHealth,
    accessibilityStatus: () => ({ ...w.accessibility }),
    probeScreen: () => new Promise<Health>((resolve, reject) => { probes.push({ resolve, reject }); }),
  });
  const calls: unknown[] = [];
  const track = (p: Promise<unknown>): void => {
    const index = calls.length;
    calls.push('pending');
    p.then(
      (v) => { calls[index] = { value: v === undefined ? null : v }; },
      (e: Error & { code?: string; readiness?: unknown }) => { calls[index] = { rejected: { message: e.message, code: e.code ?? null, readiness: e.readiness ?? null } }; },
    );
  };
  const steps: unknown[] = [];
  for (const e of input.events) {
    const probesBefore = probes.length;
    world.logs.length = 0;
    switch (e.t) {
      case 'set':
        if (e.platform !== undefined) w.platform = e.platform;
        if (e.screenStatus !== undefined) w.screenStatus = e.screenStatus;
        if (e.screenHealth !== undefined) w.screenHealth = e.screenHealth;
        if (e.accessibility !== undefined) w.accessibility = { ...w.accessibility, ...e.accessibility };
        if (e.now !== undefined) w.now = e.now;
        break;
      case 'inspect': track(current.inspect({ verifyScreen: e.verify })); break;
      case 'assert': track(current.assertCanAccrue()); break;
      case 'requestAccess': track(current.requestScreenAccess()); break;
      case 'resolveProbe': {
        const probe = probes[e.probe];
        if (probe) {
          if (e.health === 'throw') probe.reject(new Error('probe exploded'));
          else probe.resolve(e.health);
        }
        break;
      }
      case 'noteHealth': current.noteScreenHealth(e.health); break;
      case 'invalidate': current.invalidateScreenProbe(); break;
    }
    await settle();
    steps.push({
      probes: probes.length - probesBefore,
      logs: world.logs.map((l) => ({ level: l.level, message: l.message, fields: l.meta })),
      calls: [...calls],
    });
  }
  return steps;
}

function genAx(rng: Rng): Ax {
  const trusted = rng.chance(0.8);
  return {
    trusted,
    ready: trusted ? rng.chance(0.8) : rng.chance(0.3),
    recording: rng.chance(0.4),
    capturing: rng.chance(0.4),
    hookRunning: rng.chance(0.4),
    lastHookError: rng.chance(0.15) ? rng.pick(['native hook denied', 'Error: boom', '']) : null,
  };
}

function genIn(rng: Rng): In {
  const events: Event[] = [];
  const total = smallCount(rng, 2, 30);
  let probeCount = 0;
  for (let i = 0; i < total; i++) {
    const kind = rng.weighted<Event['t']>([['set', 16], ['inspect', 24], ['assert', 8], ['requestAccess', 6], ['resolveProbe', 26], ['noteHealth', 8], ['invalidate', 6]]);
    switch (kind) {
      case 'set': {
        const set: Extract<Event, { t: 'set' }> = { t: 'set' };
        if (rng.chance(0.15)) set.platform = rng.pick(['darwin', 'win32', 'linux'] as const);
        if (rng.chance(0.4)) set.screenStatus = rng.weighted<ScreenStatus>([['granted', 50], ['denied', 15], ['restricted', 8], ['not-determined', 14], ['unknown', 13]]);
        if (rng.chance(0.4)) set.screenHealth = rng.pick(HEALTHS);
        if (rng.chance(0.3)) set.accessibility = genAx(rng);
        if (rng.chance(0.1)) set.now = rng.pick([T0, 0, 8.64e15, 8.64e15 + 1, 1791133383891.2627]);
        events.push(set);
        break;
      }
      case 'inspect': events.push({ t: kind, verify: rng.chance(0.75) }); break;
      case 'resolveProbe': events.push({ t: kind, probe: probeCount > 0 ? rng.int(0, probeCount) : 0, health: rng.weighted<Health | 'throw'>([['ok', 40], ['empty', 15], ['error', 15], ['no-permission', 8], ['unknown', 8], ['throw', 14]]) }); break;
      case 'noteHealth': events.push({ t: kind, health: rng.pick(HEALTHS) }); break;
      default: events.push({ t: kind } as Event);
    }
    if (kind === 'inspect' || kind === 'assert' || kind === 'requestAccess') probeCount += 1;
  }
  return {
    platform: rng.weighted<Platform>([['darwin', 80], ['win32', 15], ['linux', 5]]),
    screenStatus: rng.weighted<ScreenStatus>([['granted', 65], ['denied', 12], ['restricted', 5], ['not-determined', 10], ['unknown', 8]]),
    screenHealth: rng.pick(HEALTHS),
    accessibility: genAx(rng),
    now: maybeFrac(rng, T0 + rng.int(-1000, 1000), 0.5),
    events,
  };
}

function edge(): In[] {
  const base = { platform: 'darwin' as Platform, screenStatus: 'granted' as ScreenStatus, screenHealth: 'unknown' as Health, accessibility: { trusted: true, ready: true, recording: false, capturing: false, hookRunning: false, lastHookError: null } as Ax, now: T0 };
  const R = (probe: number, health: Health | 'throw'): Event => ({ t: 'resolveProbe', probe, health });
  return [
    { ...base, events: [{ t: 'inspect', verify: true }, R(0, 'ok')] },
    { ...base, screenStatus: 'not-determined', events: [{ t: 'inspect', verify: true }] },
    { ...base, screenStatus: 'denied', screenHealth: 'no-permission', events: [{ t: 'inspect', verify: false }] },
    { ...base, screenHealth: 'error', events: [{ t: 'inspect', verify: true }, R(0, 'error')] },
    { ...base, accessibility: { ...base.accessibility, trusted: false }, events: [{ t: 'inspect', verify: true }, R(0, 'ok')] },
    { ...base, accessibility: { ...base.accessibility, ready: false }, events: [{ t: 'inspect', verify: true }, R(0, 'ok')] },
    { ...base, accessibility: { ...base.accessibility, lastHookError: 'native hook denied' }, events: [{ t: 'inspect', verify: true }, R(0, 'ok')] },
    { ...base, screenStatus: 'denied', events: [{ t: 'assert' }, { t: 'assert' }] },
    { ...base, platform: 'win32', screenStatus: 'denied', accessibility: { ...base.accessibility, trusted: false, ready: false }, events: [{ t: 'inspect', verify: true }] },
    { ...base, screenHealth: 'empty', events: [{ t: 'inspect', verify: true }, R(0, 'empty'), { t: 'inspect', verify: true }, R(1, 'empty')] },
    // noteScreenHealth / invalidate between the probe starting and finishing
    { ...base, events: [{ t: 'inspect', verify: true }, { t: 'noteHealth', health: 'error' }, R(0, 'ok'), { t: 'inspect', verify: true }, { t: 'invalidate' }, { t: 'inspect', verify: true }, R(1, 'ok')] },
    { ...base, events: [{ t: 'requestAccess' }, R(0, 'error'), R(1, 'ok'), { t: 'requestAccess' }, R(2, 'ok')] },
    { ...base, events: [{ t: 'inspect', verify: true }, R(0, 'throw'), { t: 'inspect', verify: true }, R(1, 'ok')] },
    { ...base, events: [{ t: 'noteHealth', health: 'ok' }, { t: 'inspect', verify: true }, { t: 'noteHealth', health: 'unknown' }, { t: 'inspect', verify: true }, { t: 'noteHealth', health: 'empty' }, { t: 'inspect', verify: true }, R(0, 'ok')] },
    { ...base, now: 8.64e15 + 1, events: [{ t: 'inspect', verify: false }, { t: 'inspect', verify: true }, R(0, 'ok')] },
    // the same non-ready verdict twice logs once; a different one logs again
    { ...base, screenStatus: 'denied', events: [{ t: 'inspect', verify: false }, { t: 'inspect', verify: false }, { t: 'set', screenStatus: 'restricted' }, { t: 'inspect', verify: false }, { t: 'set', screenStatus: 'denied' }, { t: 'inspect', verify: false }] },
  ];
}

const serviceSpec = await asyncSpec<In>({ module, fn: 'service', edge, random: genIn, run });

export const specs: FnSpec<any>[] = [inconclusiveSpec, serviceSpec];
