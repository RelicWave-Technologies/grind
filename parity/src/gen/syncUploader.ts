import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';
import { loadLegacy } from '../legacyStubs/register';
import { asyncSpec } from './asyncSpec';
import { remote } from './syncRemote';
import { mixed, token, ULID_ALPHABET } from './syncText';

/**
 * `capture/uploader.ts`, the REAL module:
 *  - `screenshotRetryDelayMs` and `screenshotUploadFailureDecision` over every
 *    kind of error the uploader tells apart (the policy half, SC-73);
 *  - `uploadScreenshotsNow([row])`, the sign -> Cloudinary -> complete flow with
 *    the API replaced by the `syncApi.ts` stub and `fetch` by a scripted
 *    Cloudinary: every request body, every multipart field in order, and every
 *    mark the store receives, including `Date.now()` and `Math.random()` (both
 *    pinned for the scenario).
 */
const crate = 'timo-sync' as const;
const module = 'uploader';

const up = await loadLegacy<{
  CloudinaryUploadError: new (status: number, body: string) => Error;
  screenshotRetryDelayMs: (n: number, rng?: () => number) => number;
  screenshotUploadFailureDecision: (row: { attempts: number }, err: unknown, now?: number, rng?: () => number) => unknown;
}>('services/capture/uploader.ts');
// After loadLegacy: this stub imports the real apiClient.ts, which needs the hooks registered first.
const api = await import('../legacyStubs/syncApi');

// ---------------------------------------------------------------- policy

type ErrSpec =
  | { kind: 'unauthorized'; message: string }
  | { kind: 'http'; path: string; status: number; body: string }
  | { kind: 'cloudinary'; status: number; body: string }
  | { kind: 'error'; message: string }
  | { kind: 'enoent'; path: string };

function toError(spec: ErrSpec): unknown {
  switch (spec.kind) {
    case 'unauthorized': return new api.UnauthorizedError(spec.message);
    case 'http': return new api.HttpError(spec.path, spec.status, spec.body);
    case 'cloudinary': return new up.CloudinaryUploadError(spec.status, spec.body);
    case 'error': return new Error(spec.message);
    case 'enoent': return Object.assign(new Error(`ENOENT: no such file or directory, open '${spec.path}'`), { code: 'ENOENT' });
  }
}

const STATUSES = [400, 401, 403, 404, 408, 409, 413, 422, 429, 499, 500, 502, 503, 504];
const MESSAGES = ['network reset', 'fetch failed', 'cloudinary_not_configured', 'storage_not_configured', 'x storage_not_configured y', 'boom', 'The operation was aborted due to timeout', ''];

function errSpec(rng: Rng): ErrSpec {
  return rng.weighted<() => ErrSpec>([
    [() => ({ kind: 'unauthorized', message: rng.pick(['no_tokens', 'refresh_failed']) }), 10],
    [() => ({ kind: 'http', path: '/v1/screenshots/sign', status: rng.pick(STATUSES), body: rng.pick(['', 'busy', 'cloudinary_not_configured', mixed(rng, 3)]) }), 25],
    [() => ({ kind: 'cloudinary', status: rng.pick(STATUSES), body: rng.chance(0.2) ? 'é'.repeat(rng.int(190, 215)) : rng.pick(['', 'bad signature', mixed(rng, 8), 'x'.repeat(rng.int(190, 260))]) }), 30],
    [() => ({ kind: 'error', message: rng.pick(MESSAGES) }), 25],
    [() => ({ kind: 'enoent', path: `/tmp/${token(rng, 6)}.webp` }), 10],
  ])();
}

interface DecisionInput { attempts: number; err: ErrSpec; now: number; rng: number }

const decisionInput = (rng: Rng): DecisionInput => ({
  attempts: rng.int(0, 6),
  err: errSpec(rng),
  now: rng.chance(0.8) ? 1_791_133_383_000 + rng.int(0, 1e7) : rng.int(0, 5000),
  rng: rng.pick([0, 0.5, 0.999999, rng.next(), rng.next()]),
});

// ---------------------------------------------------------------- flow

interface Reply { status: number; body: string }
interface RowSpec {
  id: string;
  timeEntryId: string | null;
  displayId: string;
  capturedAt: number;
  bytes: number;
  width: number;
  height: number;
  attempts: number;
}
interface FlowInput {
  row: RowSpec;
  fileExists: boolean;
  /** 'ok' | 'unauthorized' | status the sign call answers. */
  sign: 'ok' | 'unauthorized' | { status: number; body: string };
  signed: { apiKey: string; uploadUrl: string; timestamp: number; signature: string; publicId: string; folder: string; thumbTransform: string };
  cloud: Reply | 'network';
  complete: Reply;
  now: number;
  rng: number;
}

function flowInput(rng: Rng): FlowInput {
  const folder = `shots/${token(rng, 6)}`;
  return {
    row: {
      id: token(rng, 26, ULID_ALPHABET),
      timeEntryId: rng.chance(0.2) ? null : token(rng, 26, ULID_ALPHABET),
      displayId: rng.chance(0.1) ? mixed(rng, 3) || 'd' : `${rng.int(1, 5)}`,
      capturedAt: rng.weighted<number>([[1_791_133_383_891.2627, 10], [1_700_000_000_000 + rng.next() * 1e11, 70], [Math.floor(1_700_000_000_000 + rng.next() * 1e11), 20]]),
      bytes: rng.int(1, 300),
      width: rng.pick([1280, 1920, 2560, 3024]),
      height: rng.pick([720, 1080, 1440, 1964]),
      attempts: rng.int(0, 5),
    },
    fileExists: !rng.chance(0.08),
    sign: rng.weighted<FlowInput['sign']>([['ok', 70], ['unauthorized', 6], [{ status: 503, body: rng.pick(['cloudinary_not_configured', 'storage_not_configured', 'busy']) }, 10], [{ status: rng.pick([400, 404, 500]), body: mixed(rng, 3) }, 14]]),
    signed: {
      apiKey: token(rng, 15, '0123456789'),
      uploadUrl: `https://api.cloudinary.com/v1_1/${token(rng, 6)}/image/upload`,
      timestamp: rng.pick([1_791_133_384, 1_791_133_384.5, 1e21, rng.int(1, 2e9)]),
      signature: token(rng, 40, '0123456789abcdef'),
      publicId: `${folder}/${token(rng, 8)}`,
      folder,
      thumbTransform: rng.pick(['c_fill,w_320', 'c_limit,h_200,w_300,q_auto', 'w_1,h_1']),
    },
    cloud: rng.weighted<FlowInput['cloud']>([
      [{ status: 200, body: JSON.stringify({ secure_url: `https://res.cloudinary.com/demo/image/upload/v${rng.int(1, 9)}/${token(rng, 8)}.webp`, public_id: `p/${token(rng, 6)}` }) }, 55],
      [{ status: 200, body: JSON.stringify({ secure_url: `https://res.example/image/upload/image/upload/x/${token(rng, 4)}.webp` }) }, 6],
      [{ status: 200, body: JSON.stringify({ public_id: 'p' }) }, 5],
      [{ status: 200, body: JSON.stringify({ secure_url: '' }) }, 2],
      [{ status: rng.pick(STATUSES), body: rng.pick(['bad signature', '', mixed(rng, 6), 'x'.repeat(250)]) }, 22],
      ['network', 10],
    ]),
    complete: rng.weighted<Reply>([[{ status: 200, body: '{}' }, 80], [{ status: rng.pick([400, 500, 503]), body: 'no' }, 20]]),
    now: 1_791_133_383_000 + rng.int(0, 1e7),
    rng: rng.pick([0, 0.5, 0.999, rng.next()]),
  };
}

export const specs: Array<FnSpec<any>> = [
  {
    crate,
    module,
    fn: 'screenshotRetryDelayMs',
    edge: () => [{ n: 1, rng: 0 }, { n: 2, rng: 0.5 }, { n: 20, rng: 1 }, { n: 0, rng: 0.3 }, { n: -4, rng: 0.3 }],
    random: (rng: Rng) => ({ n: rng.int(-2, 40), rng: rng.pick([0, 0.5, 0.999999999, rng.next(), rng.next()]) }),
    call: (i: { n: number; rng: number }) => up.screenshotRetryDelayMs(i.n, () => i.rng),
  },
  {
    crate,
    module,
    fn: 'screenshotUploadFailureDecision',
    edge: () => [
      { attempts: 4, err: { kind: 'unauthorized', message: 'no_tokens' }, now: 1000, rng: 0 },
      { attempts: 4, err: { kind: 'http', path: '/v1/screenshots/sign', status: 503, body: 'cloudinary_not_configured' }, now: 1000, rng: 0 },
      { attempts: 1, err: { kind: 'error', message: 'network reset' }, now: 1000, rng: 0.5 },
      { attempts: 4, err: { kind: 'error', message: 'network reset' }, now: 1000, rng: 0.5 },
      { attempts: 0, err: { kind: 'cloudinary', status: 429, body: 'too many requests' }, now: 1000, rng: 0 },
    ] satisfies DecisionInput[],
    random: decisionInput,
    call: (i: DecisionInput) => up.screenshotUploadFailureDecision({ attempts: i.attempts }, toError(i.err), i.now, () => i.rng),
  },
  ...[await asyncSpec<FlowInput>({
    module,
    fn: 'uploadScreenshotsNow',
    edge: () => [],
    random: flowInput,
    run: (input: FlowInput) => remote('upload', input),
  })].map((s) => ({ ...s, crate })),
];
