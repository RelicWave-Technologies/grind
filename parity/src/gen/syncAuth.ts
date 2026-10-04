import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';
import { asyncSpec } from './asyncSpec';
import { remote } from './syncRemote';
import { mixed, token } from './syncText';

/**
 * `services/auth.ts`, the REAL module, driven through a random sequence of
 * operations: start a Lark login (PKCE verifier, challenge, `URLSearchParams`
 * login URL, the 9-minute reuse and 12-minute hard TTLs), redeem a deep-link
 * code, cancel, password login (`deviceName` from `os.hostname()` and
 * `process.platform`). `node:crypto`'s `randomBytes`, `os.hostname`,
 * `process.platform` and `Date.now` are replaced for the duration of a
 * scenario so the run is deterministic; everything else is the shipped code.
 * Recorded after each op: its outcome and everything it sent, saved and opened.
 */
const crate = 'timo-sync' as const;
const module = 'auth';


type Op =
  | { op: 'start'; now: number; openFails: boolean }
  | { op: 'complete'; now: number; code: string; response: unknown }
  | { op: 'cancel'; now: number }
  | { op: 'login'; now: number; email: string; password: string; hostname: string; platform: 'darwin' | 'win32' | 'linux'; response: unknown };

interface Input {
  apiUrl: string;
  scheme: 'grind' | 'timo';
  random: string[];
  ops: Op[];
}

const T0 = 1_791_133_383_000;
const MIN = 60_000;
const API_URLS = ['http://localhost:4000', 'https://timo.emiactech.com', 'https://api.example.com:8443', 'http://127.0.0.1:5000'];

function response(rng: Rng): unknown {
  return {
    accessToken: token(rng, rng.int(5, 40)),
    refreshToken: token(rng, rng.int(5, 40)),
    userId: rng.chance(0.1) ? mixed(rng, 3) || 'u' : token(rng, 8),
    workspaceId: token(rng, 8),
  };
}

function loginResponse(rng: Rng): unknown {
  return {
    accessToken: token(rng, rng.int(5, 40)),
    refreshToken: token(rng, rng.int(5, 40)),
    user: { id: token(rng, 8), workspaceId: token(rng, 8), name: mixed(rng, 3), email: 'a@b.co' },
  };
}

function generate(rng: Rng): Input {
  const ops: Op[] = [];
  let now = T0 + rng.int(0, 1e6);
  const count = rng.int(1, 9);
  for (let i = 0; i < count; i++) {
    now += rng.weighted<number>([[rng.int(0, 5_000), 40], [rng.int(8 * MIN, 9 * MIN + 1_000), 25], [rng.int(11 * MIN, 13 * MIN), 25], [rng.int(0, 2 * MIN), 10]]);
    const kind = rng.weighted<Op['op']>([['start', 45], ['complete', 25], ['cancel', 8], ['login', 22]]);
    if (kind === 'start') ops.push({ op: 'start', now, openFails: rng.chance(0.12) });
    else if (kind === 'complete') ops.push({ op: 'complete', now, code: rng.chance(0.2) ? mixed(rng, 4) : token(rng, 12), response: response(rng) });
    else if (kind === 'cancel') ops.push({ op: 'cancel', now });
    else {
      ops.push({
        op: 'login',
        now,
        email: rng.chance(0.2) ? mixed(rng, 4) : `${token(rng, 6)}@example.com`,
        password: mixed(rng, rng.int(1, 6)),
        hostname: rng.chance(0.3) ? mixed(rng, 3) || 'h' : `${token(rng, 5)}-mac.local`,
        platform: rng.pick(['darwin', 'win32', 'linux'] as const),
        response: loginResponse(rng),
      });
    }
  }
  const random = Array.from({ length: ops.length }, () => Array.from({ length: 48 }, () => rng.int(0, 255).toString(16).padStart(2, '0')).join(''));
  return { apiUrl: rng.pick(API_URLS), scheme: rng.pick(['grind', 'timo'] as const), random, ops };
}

const edge = (): Input[] => [
  { apiUrl: 'http://localhost:4000', scheme: 'timo', random: ['00'.repeat(48), 'ff'.repeat(48)], ops: [{ op: 'start', now: T0, openFails: false }, { op: 'start', now: T0 + 9 * MIN - 1, openFails: false }, { op: 'start', now: T0 + 9 * MIN, openFails: false }] },
  { apiUrl: 'http://localhost:4000', scheme: 'grind', random: ['ab'.repeat(48)], ops: [{ op: 'start', now: T0, openFails: false }, { op: 'complete', now: T0 + 12 * MIN, code: 'late', response: { accessToken: 'a', refreshToken: 'r', userId: 'u', workspaceId: 'w' } }] },
];

export const specs: Array<FnSpec<Input>> = [await asyncSpec<Input>({ module, fn: 'flow', edge, random: generate, run: (input) => remote('auth', input) })].map((s) => ({ ...s, crate }));
