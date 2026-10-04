import { loadLegacy } from '../legacyStubs/register';
import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';
import { mixed, token } from './syncText';

/**
 * Wire-format helpers of the network layer, against the real TypeScript:
 *  - `heartbeatPayload.ts::buildHeartbeatRequest` (real; recorded as the exact
 *    `JSON.stringify` text the API receives),
 *  - `URLSearchParams` and `encodeURIComponent` (the engine functions auth.ts,
 *    lark.ts and insights.ts call),
 *  - `ipc/lark.ts::createTaskErrorMessage` (module-private and Electron-bound,
 *    so its body is copied here verbatim, see the citation below).
 */
const crate = 'timo-sync' as const;

// A computed import, so the type checker does not follow the (type-only) `./timer` import into Electron code.
const { buildHeartbeatRequest } = await loadLegacy<{ buildHeartbeatRequest: (args: never) => unknown }>('services/heartbeatPayload.ts');

// ---------------------------------------------------------------- heartbeat

type Status =
  | { state: 'IDLE'; workedMs: number }
  | { state: 'RUNNING'; entryId: string; revision: number; larkTaskGuid: string | null; startedAt: number; segmentStartedAt: number | null; workedMs: number; paused: boolean; pauseReason: string | null };

interface HeartbeatInput {
  agentVersion: string;
  platform: 'darwin' | 'win32' | 'linux';
  timerStatus: Status;
  permissions?: unknown;
  startup?: unknown;
  observedAt: number;
}

const SCREEN_STATUS = ['granted', 'denied', 'restricted', 'not-determined', 'unknown'];
const HEALTH = ['ok', 'no-permission', 'empty', 'error', 'unknown'];
const SCREEN_STATE = ['ok', 'needs-grant', 'needs-settings', 'needs-restart'];
const LAUNCH_STATE = ['READY', 'NEEDS_INSTALL', 'NEEDS_REGISTRATION', 'NEEDS_APPROVAL', 'NEEDS_REPAIR', 'BLOCKED', 'UNAVAILABLE'];
const ORIGIN = ['LOGIN_ITEM', 'USER', 'UNKNOWN'];
const PAUSE = ['IDLE', 'MANUAL', 'PERMISSION_REQUIRED', null];

function permissions(rng: Rng): unknown {
  return {
    screen: { status: rng.pick(SCREEN_STATUS), health: rng.pick(HEALTH), state: rng.pick(SCREEN_STATE) },
    accessibility: { trusted: rng.chance(0.5), ready: rng.chance(0.5), recording: rng.chance(0.5), capturing: rng.chance(0.5), hookRunning: rng.chance(0.5) },
  };
}

function startup(rng: Rng): unknown {
  const state = rng.pick(LAUNCH_STATE);
  return { state, ready: state === 'READY', openedAtLogin: rng.chance(0.5), origin: rng.pick(ORIGIN) };
}

function heartbeat(rng: Rng): HeartbeatInput {
  const running = rng.chance(0.7);
  const timerStatus: Status = running
    ? {
        state: 'RUNNING',
        entryId: token(rng, rng.int(1, 30), 'ABCDEFGHJKMNPQRSTVWXYZ0123456789'),
        revision: rng.weighted<number>([[rng.int(-2, 3), 20], [rng.int(1, 5000), 60], [2 ** 40, 5]]),
        larkTaskGuid: rng.chance(0.5) ? null : token(rng, 12),
        startedAt: 1,
        segmentStartedAt: rng.chance(0.5) ? null : 1,
        workedMs: rng.int(0, 1e8),
        paused: rng.chance(0.4),
        pauseReason: rng.pick(PAUSE),
      }
    : { state: 'IDLE', workedMs: rng.int(0, 1e8) };
  const fractional = rng.weighted<number>([
    [1_791_133_383_891.2627, 10],
    [1_700_000_000_000 + rng.next() * 1e11, 70],
    [Math.floor(1_700_000_000_000 + rng.next() * 1e11), 15],
    [rng.pick([0, -1, 8.64e15, 8.64e15 + 1, -62198755200000, 253402300800000, 1e300]), 5],
  ]);
  const input: HeartbeatInput = {
    agentVersion: rng.chance(0.8) ? `0.0.${rng.int(0, 99)}-beta.${rng.int(0, 99)}` : mixed(rng, 3),
    platform: rng.pick(['darwin', 'win32', 'linux'] as const),
    timerStatus,
    observedAt: fractional,
  };
  if (rng.chance(0.7)) input.permissions = permissions(rng);
  if (rng.chance(0.7)) input.startup = startup(rng);
  return input;
}

const heartbeatEdge = (): HeartbeatInput[] => [
  { agentVersion: '0.0.2', platform: 'darwin', timerStatus: { state: 'IDLE', workedMs: 0 }, observedAt: 1 },
  { agentVersion: '0.0.2', platform: 'win32', timerStatus: { state: 'RUNNING', entryId: 'e', revision: 0, larkTaskGuid: null, startedAt: 1, segmentStartedAt: null, workedMs: 0, paused: true, pauseReason: 'MANUAL' }, observedAt: 2000.9 },
  { agentVersion: '0.0.2', platform: 'linux', timerStatus: { state: 'RUNNING', entryId: 'e', revision: 7, larkTaskGuid: 'g', startedAt: 1, segmentStartedAt: 1, workedMs: 10, paused: true, pauseReason: 'PERMISSION_REQUIRED' }, observedAt: -0.5 },
];

// ---------------------------------------------------------------- url encoding

const urlText = (rng: Rng): string => (rng.chance(0.2) ? '' : mixed(rng, rng.int(1, 6)));

// ---------------------------------------------------------------- createTaskErrorMessage

/**
 * Copied verbatim from legacy/agent/src/main/ipc/lark.ts:73-87 (`createTaskErrorMessage`);
 * the file imports `electron` and `better-sqlite3`, and the function is not exported.
 */
function createTaskErrorMessage(raw: string): string {
  if (raw.includes('409')) return 'reauth_required';
  const jsonStart = raw.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const body = JSON.parse(raw.slice(jsonStart)) as { error?: string; detail?: string };
      if (body.detail) return body.detail;
      if (body.error === 'lark_create_failed') return 'Lark rejected the task';
      if (body.error === 'internal_error') return raw;
      if (body.error) return body.error;
    } catch {
      // Fall through to a generic message below.
    }
  }
  return 'Could not create task in Lark';
}

function larkError(rng: Rng): string {
  const prefix = `HttpError: /v1/lark/tasks ${rng.pick([400, 409, 500, 502])}: `;
  const bodies = [
    '{"error":"lark_create_failed"}', '{"error":"internal_error"}', '{"error":"custom_code"}', '{"detail":"No summary"}',
    '{"error":"x","detail":""}', '{"error":""}', '{}', 'not json {', '{"detail":"Résumé 😀"}', '[1,2]', '{"error":5}', 'plain text', '',
  ];
  const text = prefix + rng.pick(bodies);
  return rng.chance(0.1) ? mixed(rng, 6) : rng.chance(0.15) ? text.replace(/ (400|409|500|502):/, ' 418:') : text;
}

export const specs: Array<FnSpec<any>> = [
  {
    crate,
    module: 'wire',
    fn: 'buildHeartbeatRequest',
    edge: heartbeatEdge,
    random: heartbeat,
    call: (input: HeartbeatInput) => buildHeartbeatRequest(input as never),
    encodeOutput: (output) => JSON.stringify(output),
  },
  {
    crate,
    module: 'wire',
    fn: 'searchParams',
    edge: () => [[['a', 'b']], [['client', 'agent'], ['code_challenge', 'Ab-_09'], ['callback_scheme', 'timo']], [['tz', 'Asia/Kolkata']], [['x y', 'é+&=%']], [], [['', '']]],
    random: (rng: Rng) => Array.from({ length: rng.int(0, 4) }, () => [urlText(rng), urlText(rng)]),
    call: (pairs: Array<[string, string]>) => new URLSearchParams(pairs).toString(),
  },
  {
    crate,
    module: 'wire',
    fn: 'encodeUriComponent',
    edge: () => ['', 'Asia/Kolkata', "a b!~*'()-_.", 'é😀/?#[]@$&+,;=', '%'],
    random: (rng: Rng) => urlText(rng),
    call: (text: string) => encodeURIComponent(text),
  },
  {
    crate,
    module: 'lark',
    fn: 'createTaskErrorMessage',
    edge: () => ['HttpError: /v1/lark/tasks 409: x', 'x {"error":"lark_create_failed"}', 'x {"detail":"d","error":"e"}', 'no braces'],
    random: larkError,
    call: createTaskErrorMessage,
  },
];
