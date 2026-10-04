import { trayMenuTitleForElapsed, trayTooltipForElapsed } from '../../../legacy/agent/src/main/trayPresentation';
import { FloatingBarVisibilityPolicy } from '../../../legacy/agent/src/main/services/floatingBarVisibility';
import { moveToApplications } from '../../../legacy/agent/src/main/services/moveToApplications';
import { defaultCorner, isVisibleEnough, resolvePosition, type Point, type Rect, type Size } from '../../../legacy/agent/src/main/windows/floatingBarPosition';
import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';
import { loadLegacy } from '../legacyStubs/register';
import { asyncSpec } from './asyncSpec';
import { DAY, T0, maybeFrac } from './common';
import { plain, smallCount } from './seq';

const module = 'desktop';

// --- trayPresentation.ts ---------------------------------------------------------------------

type TrayIn = { elapsedText?: string | null; hasIcon?: boolean };
const TEXTS = [
  '', '00:42', ' 00:42 ', '\t1:02:03\n', ' x ', '﻿x﻿', '\u0085x\u0085', '᠎x᠎', '​x​', ' x ', 'a b', '  ', '　y　', ' z',
  '           ', '  ', '\u000b\u000c', '0', '😀', 'ünï', 'a\u0085', '\u0085', '﻿', '᠎',
];

const traySpec: FnSpec<TrayIn> = {
  module,
  fn: 'trayPresentation',
  edge: () => [
    {}, { elapsedText: '' }, { elapsedText: '00:42' }, { elapsedText: '', hasIcon: false }, { elapsedText: '00:42', hasIcon: false }, { elapsedText: null }, { elapsedText: null, hasIcon: false },
    { elapsedText: '  ' }, { elapsedText: '  ', hasIcon: false }, { hasIcon: true }, { hasIcon: false },
  ],
  random: (rng) => {
    const input: TrayIn = {};
    const mode = rng.int(0, 4);
    if (mode === 1) input.elapsedText = null;
    else if (mode > 1) input.elapsedText = rng.chance(0.5) ? rng.pick(TEXTS) : `${rng.pick(TEXTS)}${rng.pick(['0:', '12:34', 'x', ''])}${rng.pick(TEXTS)}`;
    if (rng.chance(0.5)) input.hasIcon = rng.chance(0.5);
    return input;
  },
  call: (i) => {
    const opts = i.hasIcon === undefined ? undefined : { hasIcon: i.hasIcon };
    const title = opts === undefined ? trayMenuTitleForElapsed(i.elapsedText) : trayMenuTitleForElapsed(i.elapsedText, opts);
    return { title, tooltip: trayTooltipForElapsed(i.elapsedText) };
  },
};

// --- floatingBarVisibility.ts --------------------------------------------------------------------

type VisEvent = { t: 'sync'; entryId: string | null; pref: boolean } | { t: 'dismiss' } | { t: 'pref'; visible: boolean };
type VisIn = { events: VisEvent[] };
const ENTRIES = ['entry-1', 'entry-2', 'e3', '', 'é'];

const visibilitySpec: FnSpec<VisIn> = {
  module,
  fn: 'floatingBarVisibility',
  edge: () => [
    { events: [{ t: 'sync', entryId: 'entry-1', pref: true }, { t: 'sync', entryId: 'entry-1', pref: true }] },
    { events: [{ t: 'sync', entryId: 'entry-1', pref: true }, { t: 'dismiss' }, { t: 'sync', entryId: 'entry-1', pref: true }, { t: 'sync', entryId: null, pref: true }, { t: 'sync', entryId: 'entry-2', pref: true }] },
    { events: [{ t: 'sync', entryId: 'entry-1', pref: false }, { t: 'pref', visible: true }, { t: 'dismiss' }, { t: 'pref', visible: true }, { t: 'pref', visible: false }] },
    { events: [{ t: 'dismiss' }, { t: 'pref', visible: true }, { t: 'sync', entryId: null, pref: true }] },
    { events: [{ t: 'sync', entryId: 'entry-1', pref: true }, { t: 'dismiss' }, { t: 'sync', entryId: null, pref: true }, { t: 'sync', entryId: 'entry-1', pref: true }] },
  ],
  random: (rng) => ({
    events: Array.from({ length: smallCount(rng, 1, 25) }, (): VisEvent => {
      const k = rng.weighted<VisEvent['t']>([['sync', 55], ['dismiss', 20], ['pref', 25]]);
      if (k === 'sync') return { t: k, entryId: rng.chance(0.2) ? null : rng.pick(ENTRIES), pref: rng.chance(0.8) };
      if (k === 'pref') return { t: k, visible: rng.chance(0.6) };
      return { t: 'dismiss' };
    }),
  }),
  call: ({ events }) => {
    const policy = new FloatingBarVisibilityPolicy();
    return events.map((e) => (e.t === 'sync' ? policy.syncTimer(e.entryId, e.pref) : e.t === 'dismiss' ? policy.dismissCurrent() : policy.setPreferenceVisible(e.visible)));
  },
};

// --- heartbeatPayload.ts ---------------------------------------------------------------------------

interface HeartbeatModule {
  currentPlatform(p?: string): string;
  agentStateFromTimer(status: unknown): string;
  buildHeartbeatRequest(args: unknown): unknown;
}
const heartbeat = await loadLegacy<HeartbeatModule>('services/heartbeatPayload.ts');

type Status =
  | { state: 'IDLE'; workedMs: number }
  | { state: 'RUNNING'; entryId: string; revision: number; larkTaskGuid: string | null; startedAt: number; segmentStartedAt: number | null; workedMs: number; paused: boolean; pauseReason: 'IDLE' | 'MANUAL' | 'PERMISSION_REQUIRED' | null };

function genStatus(rng: Rng): Status {
  if (rng.chance(0.3)) return { state: 'IDLE', workedMs: rng.int(0, 10_000_000) };
  const paused = rng.chance(0.5);
  return {
    state: 'RUNNING',
    entryId: rng.pick(['entry-1', 'e2', 'ent_é', '']),
    revision: rng.weighted<number>([[rng.int(1, 50), 50], [0, 10], [-3, 5], [maybeFrac(rng, 7, 1), 8], [0.5, 5], [1e15, 5], [rng.pick([1, 2]), 17]]),
    larkTaskGuid: rng.chance(0.4) ? null : 'task-guid',
    startedAt: maybeFrac(rng, T0 + rng.int(-DAY, DAY), 0.6),
    segmentStartedAt: paused && rng.chance(0.7) ? null : maybeFrac(rng, T0 + rng.int(-DAY, DAY), 0.6),
    workedMs: maybeFrac(rng, rng.int(0, 10_000_000), 0.5),
    paused,
    pauseReason: paused ? rng.weighted<'IDLE' | 'MANUAL' | 'PERMISSION_REQUIRED' | null>([['IDLE', 35], ['MANUAL', 25], ['PERMISSION_REQUIRED', 30], [null, 10]]) : rng.weighted<'IDLE' | null>([[null, 80], ['IDLE', 20]]),
  };
}

const SCREEN_STATUS = ['granted', 'denied', 'restricted', 'not-determined', 'unknown'] as const;
const HEALTH = ['ok', 'no-permission', 'empty', 'error', 'unknown'] as const;
const UI_STATE = ['ok', 'needs-grant', 'needs-settings', 'needs-restart'] as const;
const LOGIN_STATE = ['READY', 'NEEDS_INSTALL', 'NEEDS_REGISTRATION', 'NEEDS_APPROVAL', 'NEEDS_REPAIR', 'BLOCKED', 'UNAVAILABLE'] as const;

type HbIn = { agentVersion: string; platform: string; timerStatus: Status; permissions?: unknown; startup?: unknown; observedAt?: number; deviceNow: number };

function genHb(rng: Rng): HbIn {
  const input: HbIn = {
    agentVersion: rng.pick(['0.0.2', '0.0.2-beta.38', '', '1.2.3-é']),
    platform: rng.pick(['darwin', 'win32', 'linux']),
    timerStatus: genStatus(rng),
    deviceNow: rng.weighted<number>([[maybeFrac(rng, T0 + rng.int(-DAY, DAY), 0.6), 90], [8.64e15, 3], [8.64e15 + 1, 2], [-8.64e15, 2], [-8.64e15 - 1, 3]]),
  };
  if (rng.chance(0.7)) input.observedAt = rng.weighted<number>([[maybeFrac(rng, T0 + rng.int(-DAY, DAY), 0.6), 70], [rng.pick([0, 1000, -1, -62198755200000, 253402300799999, 253402300800000, 8.64e15, -8.64e15, 9e15, -9e15, 1e300]), 30]]);
  if (rng.chance(0.4)) {
    input.permissions = {
      screen: { status: rng.pick(SCREEN_STATUS), health: rng.pick(HEALTH), state: rng.pick(UI_STATE) },
      accessibility: { trusted: rng.chance(0.5), ready: rng.chance(0.5), recording: rng.chance(0.5), capturing: rng.chance(0.5), hookRunning: rng.chance(0.5) },
    };
  }
  if (rng.chance(0.4)) {
    const state = rng.pick(LOGIN_STATE);
    input.startup = { state, ready: state === 'READY', openedAtLogin: rng.chance(0.5), origin: rng.pick(['LOGIN_ITEM', 'USER', 'UNKNOWN']) };
  }
  return input;
}

const heartbeatSpec: FnSpec<HbIn> = {
  module,
  fn: 'buildHeartbeatRequest',
  edge: () => {
    const running = (over: Partial<Extract<Status, { state: 'RUNNING' }>> = {}): Status => ({ state: 'RUNNING', entryId: 'entry-1', revision: 7, larkTaskGuid: null, startedAt: 1, segmentStartedAt: 1, workedMs: 10, paused: false, pauseReason: null, ...over });
    return [
      { agentVersion: '0.0.2', platform: 'darwin', timerStatus: { state: 'IDLE', workedMs: 0 }, deviceNow: 5 },
      { agentVersion: '0.0.2', platform: 'darwin', timerStatus: running(), observedAt: 1000, deviceNow: 5 },
      { agentVersion: '0.0.2', platform: 'win32', timerStatus: running({ entryId: 'entry-2', revision: 8, larkTaskGuid: 'task', segmentStartedAt: null, paused: true, pauseReason: 'IDLE' }), observedAt: 2000, deviceNow: 5 },
      { agentVersion: '0.0.2', platform: 'darwin', timerStatus: running({ paused: true, pauseReason: 'MANUAL', segmentStartedAt: null }), deviceNow: 1791133383891.2627 },
      { agentVersion: '0.0.2', platform: 'darwin', timerStatus: running({ paused: true, pauseReason: 'PERMISSION_REQUIRED', segmentStartedAt: null }), deviceNow: 7 },
      { agentVersion: '0.0.2', platform: 'darwin', timerStatus: running({ revision: 0 }), observedAt: 0, deviceNow: 7 },
      { agentVersion: '0.0.2', platform: 'darwin', timerStatus: running(), observedAt: 8.64e15 + 1, deviceNow: 7 },
      { agentVersion: '0.0.2', platform: 'darwin', timerStatus: { state: 'IDLE', workedMs: 0 }, observedAt: 8.64e15 + 1, deviceNow: 7 },
      { agentVersion: '0.0.2', platform: 'darwin', timerStatus: { state: 'IDLE', workedMs: 0 }, permissions: { screen: { status: 'granted', health: 'ok', state: 'ok' }, accessibility: { trusted: true, ready: true, recording: false, capturing: false, hookRunning: false } }, deviceNow: 7 },
      { agentVersion: '0.0.2', platform: 'win32', timerStatus: { state: 'IDLE', workedMs: 0 }, startup: { state: 'NEEDS_REPAIR', ready: false, openedAtLogin: false, origin: 'USER' }, deviceNow: 7 },
    ];
  },
  random: genHb,
  call: (i) => {
    const realNow = Date.now;
    Date.now = () => i.deviceNow;
    try {
      const args: Record<string, unknown> = { agentVersion: i.agentVersion, platform: i.platform, timerStatus: i.timerStatus };
      if (i.permissions !== undefined) args.permissions = i.permissions;
      if (i.startup !== undefined) args.startup = i.startup;
      if (i.observedAt !== undefined) args.observedAt = i.observedAt;
      return heartbeat.buildHeartbeatRequest(args);
    } finally {
      Date.now = realNow;
    }
  },
};

const agentStateSpec: FnSpec<{ timerStatus: Status }> = {
  module,
  fn: 'agentStateFromTimer',
  edge: () => [{ timerStatus: { state: 'IDLE', workedMs: 0 } }],
  random: (rng) => ({ timerStatus: genStatus(rng) }),
  call: ({ timerStatus }) => heartbeat.agentStateFromTimer(timerStatus),
};

const platformSpec: FnSpec<{ nodePlatform: string }> = {
  module,
  fn: 'currentPlatform',
  edge: () => ['darwin', 'win32', 'linux', 'freebsd', '', 'Darwin', 'aix', 'sunos', 'android'].map((nodePlatform) => ({ nodePlatform })),
  random: (rng) => ({ nodePlatform: rng.pick(['darwin', 'win32', 'linux', 'freebsd', 'openbsd', 'aix', 'sunos', 'android', 'cygwin', 'netbsd', 'haiku', 'x']) }),
  call: ({ nodePlatform }) => heartbeat.currentPlatform(nodePlatform),
};

// --- moveToApplications.ts -----------------------------------------------------------------------------

type MoveIn = { tracking: boolean; confirm: boolean; move: 'true' | 'false' | 'throws' };

const moveSpec = await asyncSpec<MoveIn>({
  module,
  fn: 'moveToApplications',
  edge: () => {
    const out: MoveIn[] = [];
    for (const tracking of [false, true]) for (const confirm of [true, false]) for (const move of ['true', 'false', 'throws'] as const) out.push({ tracking, confirm, move });
    return out;
  },
  random: (rng) => ({ tracking: rng.chance(0.25), confirm: rng.chance(0.7), move: rng.pick(['true', 'false', 'throws'] as const) }),
  run: async ({ tracking, confirm, move }) => {
    const calls: string[] = [];
    const result = await moveToApplications({
      isTracking: () => { calls.push('isTracking'); return tracking; },
      confirm: async () => { calls.push('confirm'); return confirm; },
      cleanup: async () => { calls.push('cleanup'); },
      move: () => {
        calls.push('move');
        if (move === 'throws') throw new Error('move failed');
        return move === 'true';
      },
      invalidateCleanup: () => { calls.push('invalidateCleanup'); },
    });
    return { result, calls };
  },
});

// --- floatingBarPosition.ts -------------------------------------------------------------------------------

const coord = (rng: Rng): number =>
  rng.weighted<number>([
    [rng.int(-2000, 4000), 55],
    [maybeFrac(rng, rng.int(-2000, 4000), 1), 15],
    [rng.pick([0, 48, 47, 49, -48, 1920, 1080, 25, -1920]), 20],
    [rng.pick([1e15, -1e15, 2 ** 52]), 5],
    [rng.pick([0.5, 1 / 3, 47.9999999, 48.0000001]), 5],
  ]);
const dim = (rng: Rng): number => rng.weighted<number>([[rng.pick([268, 44, 340, 1920, 1080, 1440, 875, 48, 47, 49, 100]), 60], [rng.int(0, 3000), 20], [maybeFrac(rng, rng.int(1, 2000), 1), 15], [rng.pick([0, 1e15]), 5]]);
const rect = (rng: Rng): Rect => ({ x: coord(rng), y: coord(rng), width: dim(rng), height: dim(rng) });
const sizeOf = (rng: Rng): Size => ({ width: dim(rng), height: dim(rng) });
const pointOf = (rng: Rng): Point => ({ x: coord(rng), y: coord(rng) });

const defaultCornerSpec: FnSpec<{ primary: Rect; size: Size }> = {
  module,
  fn: 'defaultCorner',
  edge: () => [{ primary: { x: 0, y: 25, width: 1440, height: 875 }, size: { width: 268, height: 44 } }],
  random: (rng) => ({ primary: rect(rng), size: sizeOf(rng) }),
  call: ({ primary, size }) => plain(defaultCorner(primary, size)),
};

const visibleSpec: FnSpec<{ pos: Point; size: Size; workAreas: Rect[] }> = {
  module,
  fn: 'isVisibleEnough',
  edge: () => [
    { pos: { x: 0, y: 0 }, size: { width: 268, height: 44 }, workAreas: [{ x: 0, y: 0, width: 1920, height: 1080 }] },
    { pos: { x: 1900, y: 0 }, size: { width: 268, height: 44 }, workAreas: [{ x: 0, y: 0, width: 1920, height: 1080 }] },
    { pos: { x: 1872, y: 0 }, size: { width: 268, height: 44 }, workAreas: [{ x: 0, y: 0, width: 1920, height: 1080 }] },
    { pos: { x: 1873, y: 0 }, size: { width: 268, height: 44 }, workAreas: [{ x: 0, y: 0, width: 1920, height: 1080 }] },
    { pos: { x: 0, y: 0 }, size: { width: 20, height: 20 }, workAreas: [] },
  ],
  random: (rng) => {
    const wa = rect(rng);
    const size = sizeOf(rng);
    const near = rng.chance(0.6);
    return { pos: near ? { x: wa.x + rng.int(-400, wa.width + 100), y: wa.y + rng.int(-100, wa.height + 100) } : pointOf(rng), size, workAreas: [wa, ...Array.from({ length: rng.int(0, 2) }, () => rect(rng))] };
  },
  call: ({ pos, size, workAreas }) => isVisibleEnough(pos, size, workAreas),
};

const resolveSpec: FnSpec<{ saved: Point | null; size: Size; primary: Rect; workAreas: Rect[] }> = {
  module,
  fn: 'resolvePosition',
  edge: () => [
    { saved: null, size: { width: 268, height: 44 }, primary: { x: 0, y: 25, width: 1440, height: 875 }, workAreas: [{ x: 0, y: 25, width: 1440, height: 875 }] },
    { saved: { x: 100, y: 100 }, size: { width: 268, height: 44 }, primary: { x: 0, y: 25, width: 1440, height: 875 }, workAreas: [{ x: 0, y: 25, width: 1440, height: 875 }] },
    { saved: { x: 5000, y: 5000 }, size: { width: 268, height: 44 }, primary: { x: 0, y: 25, width: 1440, height: 875 }, workAreas: [{ x: 0, y: 25, width: 1440, height: 875 }] },
  ],
  random: (rng) => {
    const primary = rect(rng);
    const size = sizeOf(rng);
    const saved = rng.chance(0.2) ? null : rng.chance(0.6) ? { x: primary.x + rng.int(-300, primary.width + 50), y: primary.y + rng.int(-100, primary.height + 50) } : pointOf(rng);
    return { saved, size, primary, workAreas: [primary, ...Array.from({ length: rng.int(0, 2) }, () => rect(rng))] };
  },
  call: ({ saved, size, primary, workAreas }) => plain(resolvePosition(saved, size, primary, workAreas)),
};

// --- overlay.ts placement helpers -------------------------------------------------------------------------------

interface OverlayModule {
  center(wa: Rect, size: Size): Point;
  topRight(wa: Rect, size: Size, gutter?: number): Point;
  bottomRight(wa: Rect, size: Size, gutter?: number): Point;
  trayPopoverPoint(tray: Rect, wa: Rect, size: Size, gutter?: number): Point;
}
const overlay = await loadLegacy<OverlayModule>('windows/overlay.ts');

type PlaceIn = { tray: Rect; wa: Rect; size: Size; gutter?: number };

function genPlace(rng: Rng): PlaceIn {
  const wa = rect(rng);
  const tray = rng.chance(0.7) ? { x: wa.x + rng.int(0, Math.max(1, Math.floor(wa.width))), y: rng.pick([wa.y - 25, wa.y + wa.height, wa.y, wa.y + wa.height - 40]), width: rng.pick([24, 25, 32, 40]), height: rng.pick([24, 25, 40]) } : rect(rng);
  const input: PlaceIn = { tray, wa, size: sizeOf(rng) };
  if (rng.chance(0.4)) input.gutter = rng.weighted<number>([[rng.pick([0, 6, 16, 20, 1, 10]), 70], [maybeFrac(rng, 8, 1), 20], [rng.pick([-5, 1e9]), 10]]);
  return input;
}

const placeEdge = (): PlaceIn[] => {
  const WORK: Rect = { x: 0, y: 25, width: 1440, height: 875 };
  const tray = (x: number, y: number, w = 24, h = 24): Rect => ({ x, y, width: w, height: h });
  return [
    { tray: tray(1200, 0), wa: WORK, size: { width: 481, height: 332 } },
    { tray: tray(1200, 0), wa: { x: -1920, y: 0, width: 1920, height: 1080 }, size: { width: 481, height: 332 } },
    { tray: tray(1200, 0), wa: WORK, size: { width: 320, height: 168 }, gutter: 16 },
    { tray: tray(1200, 0), wa: WORK, size: { width: 268, height: 44 }, gutter: 20 },
    { tray: tray(1200, 0), wa: WORK, size: { width: 300, height: 340 } },
    { tray: tray(1430, 0), wa: WORK, size: { width: 300, height: 340 } },
    { tray: tray(1800, 1040, 24, 40), wa: { x: 0, y: 0, width: 1920, height: 1040 }, size: { width: 300, height: 340 } },
    { tray: tray(1000, 0, 25, 24), wa: WORK, size: { width: 300, height: 340 } },
    { tray: tray(0, 0), wa: { x: 0, y: 0, width: 100, height: 100 }, size: { width: 300, height: 340 } },
  ];
};

const placeSpecs: FnSpec<PlaceIn>[] = (['center', 'topRight', 'bottomRight', 'trayPopoverPoint'] as const).map((fn) => ({
  module,
  fn,
  edge: placeEdge,
  random: genPlace,
  call: ({ tray, wa, size, gutter }: PlaceIn) => {
    switch (fn) {
      case 'center': return plain(overlay.center(wa, size));
      case 'topRight': return plain(gutter === undefined ? overlay.topRight(wa, size) : overlay.topRight(wa, size, gutter));
      case 'bottomRight': return plain(gutter === undefined ? overlay.bottomRight(wa, size) : overlay.bottomRight(wa, size, gutter));
      case 'trayPopoverPoint': return plain(gutter === undefined ? overlay.trayPopoverPoint(tray, wa, size) : overlay.trayPopoverPoint(tray, wa, size, gutter));
    }
  },
}));

export const specs: FnSpec<any>[] = [traySpec, visibilitySpec, heartbeatSpec, agentStateSpec, platformSpec, moveSpec, defaultCornerSpec, visibleSpec, resolveSpec, ...placeSpecs];
