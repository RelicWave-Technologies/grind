import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';
import { loadLegacy } from '../legacyStubs/register';
import { DAY, T0, maybeFrac } from './common';
import { plain, smallCount } from './seq';

const module = 'updates';

interface UpdatesState {
  initialUpdateStatus(args: { enabled: boolean; currentVersion: string; channel: 'latest' | 'beta'; canInstallNow?: boolean }): unknown;
  canInstallUpdate(timer: { state: 'IDLE' } | { state: 'RUNNING'; paused: boolean }): boolean;
  nextRetryDelayMs(n: number): number | null;
  compareVersions(a: string, b: string): number | null;
  isVersionNewer(current: string, candidate: string | null | undefined): boolean;
  applyUpdateEvent(status: unknown, event: unknown): unknown;
}
const state = await loadLegacy<UpdatesState>('services/updates/state.ts');

const PRERELEASE = ['beta.1', 'beta.2', 'beta.10', 'beta.01', 'alpha', 'alpha.1', 'rc.1', '0', '1', '01', '2', 'beta', 'beta.1.2', 'a..b', 'x-y', '', 'ä', 'Beta.1', 'beta.1a', '1.2', '1.a', 'a.1', '9007199254740993', '9007199254740992', '00', '0.0'];

function version(rng: Rng): string {
  const num = (): string => rng.weighted<string>([[String(rng.int(0, 12)), 70], [String(rng.int(0, 1000)), 10], [rng.pick(['007', '00', '99999999999999999999', '9007199254740993', '9007199254740992', '1e3', '0']), 20]]);
  let v = `${num()}.${num()}.${num()}`;
  if (rng.chance(0.35)) v += `-${rng.pick(PRERELEASE)}`;
  if (rng.chance(0.15)) v = `v${v}`;
  return v;
}

const INVALID = ['', '1.2', '1.2.3.4', ' 1.2.3', '1.2.3 ', '1.2.3\n', '\n1.2.3', 'V1.2.3', 'vv1.2.3', '1.2.3-', '1.2.3+build', '1.2.3-beta+x', '١.٢.٣', '1.2.3-β', '1..3', '.1.2', 'latest', 'v', '1.2.3-beta_1', '1.2.-3', '-1.2.3', '1.2.3-beta.1\n', '１.２.３'];

const anyVersion = (rng: Rng): string => (rng.chance(0.12) ? rng.pick(INVALID) : version(rng));

const compareSpec: FnSpec<{ a: string; b: string }> = {
  module,
  fn: 'compareVersions',
  edge: () => [
    { a: '1.2.3', b: '1.2.3' }, { a: '1.2.4', b: '1.2.3' }, { a: '1.2.3', b: '1.2.4' }, { a: '1.2.3', b: '1.2.3-beta.1' }, { a: '1.2.3-beta.1', b: '1.2.3' },
    { a: '1.2.3-beta.2', b: '1.2.3-beta.10' }, { a: '1.2.3-beta', b: '1.2.3-beta.1' }, { a: '1.2.3-1', b: '1.2.3-alpha' }, { a: '1.2.3-alpha', b: '1.2.3-1' },
    { a: 'v1.2.3', b: '1.2.3' }, { a: '1.2', b: '1.2.3' }, { a: '1.2.3', b: 'junk' }, { a: '0.0.2-beta.38', b: '0.0.2-beta.37' }, { a: '0.0.2-beta.9', b: '0.0.2-beta.38' },
    { a: '1.2.3-01', b: '1.2.3-1' }, { a: '1.2.3-a..b', b: '1.2.3-a.b' }, { a: '9007199254740993.0.0', b: '9007199254740992.0.0' },
  ],
  random: (rng) => {
    const a = anyVersion(rng);
    const b = rng.chance(0.3) ? a : rng.chance(0.4) ? a.replace(/\d+$/, (m) => String(Number(m) + rng.int(-1, 1))) : anyVersion(rng);
    return { a, b };
  },
  call: ({ a, b }) => state.compareVersions(a, b),
};

const newerSpec: FnSpec<{ current: string; candidate?: string | null }> = {
  module,
  fn: 'isVersionNewer',
  edge: () => [
    { current: '1.0.0', candidate: '1.0.1' }, { current: '1.0.1', candidate: '1.0.0' }, { current: '1.0.0', candidate: '1.0.0' }, { current: '1.0.0' }, { current: '1.0.0', candidate: null },
    { current: '1.0.0', candidate: '' }, { current: 'weird', candidate: 'weirder' }, { current: 'weird', candidate: 'weird' }, { current: '1.0.0', candidate: 'weird' },
  ],
  random: (rng) => {
    const input: { current: string; candidate?: string | null } = { current: anyVersion(rng) };
    const c = rng.int(0, 9);
    if (c === 0) input.candidate = null;
    else if (c > 1) input.candidate = anyVersion(rng);
    return input;
  },
  call: ({ current, candidate }) => state.isVersionNewer(current, candidate),
};

const retrySpec: FnSpec<{ n: number }> = {
  module,
  fn: 'nextRetryDelayMs',
  edge: () => [0, 1, 2, 3, 4, -1, 0.5, 1.5, 2.5, 1.0000001, 2.0000001, 1e9].map((n) => ({ n })),
  random: (rng) => ({ n: rng.weighted<number>([[rng.int(0, 5), 70], [maybeFrac(rng, rng.int(0, 4), 1), 20], [rng.pick([-3, 1e300, 1.9999999999999998]), 10]]) }),
  call: ({ n }) => state.nextRetryDelayMs(n),
};

const canInstallSpec: FnSpec<{ timer: { state: 'IDLE' } | { state: 'RUNNING'; paused: boolean } }> = {
  module,
  fn: 'canInstallUpdate',
  edge: () => [{ timer: { state: 'IDLE' } }, { timer: { state: 'RUNNING', paused: false } }, { timer: { state: 'RUNNING', paused: true } }],
  random: (rng) => ({ timer: rng.chance(0.4) ? { state: 'IDLE' } : { state: 'RUNNING', paused: rng.chance(0.5) } }),
  call: ({ timer }) => state.canInstallUpdate(timer),
};

type InitIn = { enabled: boolean; currentVersion: string; channel: 'latest' | 'beta'; canInstallNow?: boolean };
const initialSpec: FnSpec<InitIn> = {
  module,
  fn: 'initialUpdateStatus',
  edge: () => [{ enabled: true, currentVersion: '0.0.2', channel: 'latest' }, { enabled: false, currentVersion: '0.0.2-beta.38', channel: 'beta', canInstallNow: false }, { enabled: true, currentVersion: '', channel: 'beta', canInstallNow: true }],
  random: (rng) => {
    const input: InitIn = { enabled: rng.chance(0.6), currentVersion: anyVersion(rng), channel: rng.pick(['latest', 'beta'] as const) };
    if (rng.chance(0.5)) input.canInstallNow = rng.chance(0.5);
    return input;
  },
  call: (args) => plain(state.initialUpdateStatus(args)),
};

// --- applyUpdateEvent -----------------------------------------------------------------------------------

type Ev =
  | { type: 'checking'; manual: boolean; at: number }
  | { type: 'available'; version: string | null }
  | { type: 'download-progress'; percent: number }
  | { type: 'downloaded'; version: string | null; canInstallNow: boolean; at: number }
  | { type: 'installing'; at: number }
  | { type: 'not-available'; manual: boolean; at: number }
  | { type: 'error'; message: string; manual: boolean; at: number }
  | { type: 'timer-changed'; canInstallNow: boolean };
type ApplyIn = { init: InitIn; events: Ev[] };

function genEvent(rng: Rng, current: string): Ev {
  const at = maybeFrac(rng, T0 + rng.int(-DAY, DAY), 0.5);
  const ver = (): string | null => rng.weighted<string | null>([[null, 12], [current, 15], [version(rng), 55], [rng.pick(INVALID), 8], [current.replace(/\d+(?=[^\d]*$)/, (m) => String(Number(m) + 1)), 10]]);
  switch (rng.weighted<Ev['type']>([['checking', 14], ['available', 18], ['download-progress', 16], ['downloaded', 16], ['installing', 6], ['not-available', 10], ['error', 10], ['timer-changed', 10]])) {
    case 'checking': return { type: 'checking', manual: rng.chance(0.5), at };
    case 'available': return { type: 'available', version: ver() };
    case 'download-progress': return { type: 'download-progress', percent: rng.weighted<number>([[rng.int(0, 100), 60], [maybeFrac(rng, rng.int(0, 100), 1), 15], [rng.pick([-5, 100.5, 1e9, 0, 100]), 25]]) };
    case 'downloaded': return { type: 'downloaded', version: ver(), canInstallNow: rng.chance(0.5), at };
    case 'installing': return { type: 'installing', at };
    case 'not-available': return { type: 'not-available', manual: rng.chance(0.5), at };
    case 'error': return { type: 'error', message: rng.pick(['net::ERR', '', 'boom', 'é']), manual: rng.chance(0.5), at };
    case 'timer-changed': return { type: 'timer-changed', canInstallNow: rng.chance(0.5) };
  }
}

const applySpec: FnSpec<ApplyIn> = {
  module,
  fn: 'applyUpdateEvent',
  edge: () => {
    const init: InitIn = { enabled: true, currentVersion: '1.0.0', channel: 'latest' };
    return [
      { init, events: [{ type: 'checking', manual: true, at: 1 }, { type: 'available', version: '1.0.1' }, { type: 'download-progress', percent: 50 }, { type: 'downloaded', version: '1.0.1', canInstallNow: false, at: 2 }, { type: 'timer-changed', canInstallNow: true }, { type: 'installing', at: 3 }] },
      { init, events: [{ type: 'available', version: '1.0.0' }, { type: 'downloaded', version: null, canInstallNow: true, at: 5 }, { type: 'available', version: null }] },
      { init, events: [{ type: 'available', version: '1.0.1' }, { type: 'available', version: null }, { type: 'downloaded', version: null, canInstallNow: true, at: 5 }] },
      { init, events: [{ type: 'error', message: 'boom', manual: false, at: 9 }, { type: 'checking', manual: false, at: 10 }, { type: 'not-available', manual: true, at: 11 }] },
      { init: { enabled: true, currentVersion: 'dev', channel: 'beta' }, events: [{ type: 'available', version: 'dev2' }, { type: 'available', version: 'dev' }, { type: 'downloaded', version: 'dev2', canInstallNow: true, at: 1 }] },
      { init, events: [{ type: 'download-progress', percent: -4 }, { type: 'download-progress', percent: 140 }, { type: 'download-progress', percent: 33.3333333 }] },
    ];
  },
  random: (rng) => {
    const init: InitIn = { enabled: rng.chance(0.7), currentVersion: version(rng), channel: rng.pick(['latest', 'beta'] as const) };
    if (rng.chance(0.4)) init.canInstallNow = rng.chance(0.5);
    return { init, events: Array.from({ length: smallCount(rng, 1, 22) }, () => genEvent(rng, init.currentVersion)) };
  },
  call: ({ init, events }) => {
    let status = state.initialUpdateStatus(init);
    return plain(events.map((e) => (status = state.applyUpdateEvent(status, e))));
  },
};

export const specs: FnSpec<any>[] = [compareSpec, newerSpec, retrySpec, canInstallSpec, initialSpec, applySpec];
