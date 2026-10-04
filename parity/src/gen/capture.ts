import { nextDelayMs, shouldDeferCapture } from '../../../legacy/agent/src/main/services/capture/scheduler';
import { planScreenshotRetention, type RetentionInput } from '../../../legacy/agent/src/main/services/capture/retention';
import { AsyncLru } from '../../../legacy/agent/src/main/services/capture/asyncLru';
import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';
import { loadLegacy } from '../legacyStubs/register';
import { asyncSpec } from './asyncSpec';
import { DAY, DELTAS, MAX_EXACT, T0, maybeFrac } from './common';
import { plain, smallCount } from './seq';

const module = 'capture';

// --- scheduler.ts --------------------------------------------------------------------

const intervalMs = (rng: Rng): number =>
  rng.weighted<() => number>([
    [() => rng.pick([60_000, 120_000, 180_000, 15_000, 1000, 999, 1000.4, 1000.5, 1001, 0, -5, 60_000.4, 60_000.5, 0.5, 1.5, 2.5]), 40],
    [() => maybeFrac(rng, rng.int(0, 400_000), 0.8), 40],
    [() => rng.pick([1e15, MAX_EXACT, -1e15, 1e-9, 4503599627370495.5]), 10],
    [() => rng.int(0, 5000), 10],
  ])();

const nextDelaySpec: FnSpec<{ ms: number }> = {
  module,
  fn: 'nextDelayMs',
  edge: () => [{ ms: 180_000 }, { ms: 60_000.4 }, { ms: 60_000.5 }, { ms: 0 }, { ms: 999.5 }, { ms: 1000.5 }, { ms: -0.4 }, { ms: 1e300 }],
  random: (rng) => ({ ms: intervalMs(rng) }),
  call: ({ ms }) => plain(nextDelayMs(ms)),
};

const deferSpec: FnSpec<{ idleSeconds: number; deferrals: number }> = {
  module,
  fn: 'shouldDeferCapture',
  edge: () => [
    { idleSeconds: 0, deferrals: 0 }, { idleSeconds: 1, deferrals: 0 }, { idleSeconds: 2, deferrals: 0 }, { idleSeconds: 30, deferrals: 0 },
    { idleSeconds: 0, deferrals: 2 }, { idleSeconds: 0, deferrals: 3 }, { idleSeconds: 0, deferrals: 8 }, { idleSeconds: 1.999, deferrals: 2.5 }, { idleSeconds: -1, deferrals: 0 },
  ],
  random: (rng) => ({
    idleSeconds: rng.weighted<number>([[rng.int(0, 5), 50], [maybeFrac(rng, rng.int(0, 4), 1), 20], [rng.int(0, 600), 20], [rng.pick([2, 1.9999999, 2.0000001, -1, 0]), 10]]),
    deferrals: rng.weighted<number>([[rng.int(0, 5), 70], [maybeFrac(rng, rng.int(0, 4), 1), 10], [rng.pick([2.9999999, 3, 3.0000001, -1, 1e9]), 20]]),
  }),
  call: ({ idleSeconds, deferrals }) => shouldDeferCapture(idleSeconds, deferrals),
};

// --- retention.ts --------------------------------------------------------------------------

const PATHS = ['/s/a.webp', '/s/b.webp', '/s/c.webp', '/s/old.webp', '/s/new.webp', '/s/orphan.webp', '/s/gone.webp', '/s/é.webp', '/s/a.webp ', '/s/A.webp', ''];
const IDS = ['a', 'b', 'c', 'old', 'new', 'gone', 'x1', 'x2', 'é', ''];

function genRetention(rng: Rng): RetentionInput {
  const now = maybeFrac(rng, T0 + rng.int(-DAY, DAY), 0.5);
  const retentionDays = rng.weighted<number>([[60, 55], [0, 10], [-1, 5], [30, 8], [0.5, 4], [1e9, 3], [maybeFrac(rng, 7, 1), 5], [rng.int(1, 400), 10]]);
  const cutoff = now - retentionDays * DAY;
  const rowCount = smallCount(rng, 0, 8);
  const rows = Array.from({ length: rowCount }, () => ({
    id: rng.chance(0.85) ? rng.pick(IDS) : `id${rng.int(0, 99)}`,
    filePath: rng.chance(0.85) ? rng.pick(PATHS) : `/s/${rng.int(0, 99)}.webp`,
    capturedAt: rng.weighted<number>([
      [maybeFrac(rng, now - rng.int(0, 120) * DAY, 0.5), 50],
      [cutoff, 8],
      [cutoff - 1, 6],
      [cutoff + 1, 6],
      [maybeFrac(rng, cutoff + rng.pick(DELTAS), 0.6), 20],
      [rng.pick([0, 1e15, -1e15, MAX_EXACT]), 5],
    ]),
  }));
  const fileCount = smallCount(rng, 0, 9);
  const filesOnDisk = Array.from({ length: fileCount }, () => (rng.chance(0.7) && rows.length ? rng.pick(rows).filePath : rng.pick(PATHS)));
  return { rows, filesOnDisk, now, retentionDays };
}

const retentionSpec: FnSpec<RetentionInput> = {
  module,
  fn: 'planScreenshotRetention',
  edge: () => {
    const row = (id: string, filePath: string, ageDays: number) => ({ id, filePath, capturedAt: T0 - ageDays * DAY });
    const plan = (rows: ReturnType<typeof row>[], filesOnDisk: string[], retentionDays = 60): RetentionInput => ({ rows, filesOnDisk, now: T0, retentionDays });
    return [
      plan([row('a', '/s/a.webp', 1), row('b', '/s/b.webp', 10)], ['/s/a.webp', '/s/b.webp']),
      plan([row('old', '/s/old.webp', 61), row('new', '/s/new.webp', 1)], ['/s/old.webp', '/s/new.webp']),
      plan([row('a', '/s/a.webp', 1)], ['/s/a.webp', '/s/orphan.webp']),
      plan([row('a', '/s/a.webp', 1), row('gone', '/s/gone.webp', 2)], ['/s/a.webp']),
      plan([row('old', '/s/old.webp', 90)], ['/s/old.webp']),
      plan([row('ancient', '/s/ancient.webp', 999), row('gone', '/s/gone.webp', 1)], ['/s/ancient.webp', '/s/orphan.webp'], 0),
      plan([], []),
      plan([row('a', '/s/a.webp', 60)], ['/s/a.webp']),
      plan([row('a', '/s/a.webp', 61), row('a', '/s/b.webp', 61)], ['/s/a.webp', '/s/a.webp', '/s/b.webp']),
      plan([row('a', '/s/a.webp', 1), row('b', '/s/a.webp', 1)], ['/s/z.webp', '/s/z.webp']),
    ];
  },
  random: genRetention,
  call: (input) => plain(planScreenshotRetention(input)),
};

// --- activityWindowForShot (capture/index.ts) -------------------------------------------------

type WindowIn = { capturedAt: number; olderCapturedAt?: number; defaultWindowMs: number };
interface CaptureIndex {
  activityWindowForShot(args: WindowIn): { from: number; to: number };
}
const captureIndex = await loadLegacy<CaptureIndex>('services/capture/index.ts');

const shotSpec: FnSpec<WindowIn> = {
  module,
  fn: 'activityWindowForShot',
  edge: () => {
    const DEFAULT = 30 * 60_000;
    return [
      { capturedAt: 10 * 60_000, defaultWindowMs: DEFAULT },
      { capturedAt: 3 * 60_000, olderCapturedAt: 0, defaultWindowMs: DEFAULT },
      { capturedAt: 60_015_000, olderCapturedAt: 60_000_000, defaultWindowMs: DEFAULT },
      { capturedAt: 60_030_000, olderCapturedAt: 60_000_000, defaultWindowMs: DEFAULT },
      { capturedAt: 60_060_000, olderCapturedAt: 60_000_000, defaultWindowMs: DEFAULT },
      { capturedAt: 60_300_000, olderCapturedAt: 60_000_000, defaultWindowMs: DEFAULT },
      { capturedAt: 1791133383891.2627, olderCapturedAt: 1791133330180.8308, defaultWindowMs: DEFAULT },
      { capturedAt: 0, olderCapturedAt: 0, defaultWindowMs: 0 },
    ];
  },
  random: (rng) => {
    const capturedAt = maybeFrac(rng, T0 + rng.int(-DAY, DAY), 0.6);
    const gap = rng.weighted<number>([[rng.pick([15_000, 30_000, 60_000, 120_000, 180_000, 300_000]), 50], [rng.int(0, 600_000), 25], [maybeFrac(rng, rng.int(0, 400_000), 1), 15], [-rng.int(1, 100_000), 10]]);
    const out: WindowIn = { capturedAt, defaultWindowMs: rng.weighted<number>([[30 * 60_000, 60], [rng.int(0, 7_200_000), 25], [0, 5], [maybeFrac(rng, 1_800_000, 1), 10]]) };
    if (rng.chance(0.8)) out.olderCapturedAt = capturedAt - gap;
    return out;
  },
  call: (i) => plain(captureIndex.activityWindowForShot(i)),
};

// --- uploader.ts: retry delay and failure decision -----------------------------------------------

type ErrSpec =
  | { kind: 'unauthorized'; message: string }
  | { kind: 'http'; path: string; status: number; body: string }
  | { kind: 'cloudinary'; status: number; body: string }
  | { kind: 'error'; message: string; code?: string }
  | { kind: 'plain'; code?: string }
  | { kind: 'text'; text: string };

interface UploaderModule {
  screenshotRetryDelayMs(n: number, rng?: () => number): number;
  screenshotUploadFailureDecision(row: { attempts: number }, err: unknown, now?: number, rng?: () => number): unknown;
  CloudinaryUploadError: new (status: number, body: string) => Error;
}
interface ApiModule {
  HttpError: new (path: string, status: number, body: string) => Error;
  UnauthorizedError: new (message: string) => Error;
}
const uploader = await loadLegacy<UploaderModule>('services/capture/uploader.ts');
const api = await loadLegacy<ApiModule>('services/apiClient.ts');

function buildError(e: ErrSpec): unknown {
  switch (e.kind) {
    case 'unauthorized': return new api.UnauthorizedError(e.message);
    case 'http': return new api.HttpError(e.path, e.status, e.body);
    case 'cloudinary': return new uploader.CloudinaryUploadError(e.status, e.body);
    case 'error': {
      const err = new Error(e.message);
      if (e.code !== undefined) (err as Error & { code?: string }).code = e.code;
      return err;
    }
    case 'plain': return e.code === undefined ? {} : { code: e.code };
    case 'text': return e.text;
  }
}

/** A counting `rng` that returns `r`. */
function rngOf(r: number): { rng: () => number; calls: () => number } {
  let n = 0;
  return { rng: () => { n++; return r; }, calls: () => n };
}

const unit = (rng: Rng): number => rng.weighted<number>([[0, 15], [1, 8], [0.5, 12], [rng.next(), 55], [0.9999999999999999, 5], [1e-9, 5]]);

const retryDelaySpec: FnSpec<{ attempts: number; r: number }> = {
  module,
  fn: 'screenshotRetryDelayMs',
  edge: () => [
    { attempts: 1, r: 0 }, { attempts: 2, r: 0.5 }, { attempts: 20, r: 1 }, { attempts: 0, r: 0.3 }, { attempts: -3, r: 0.3 }, { attempts: 3, r: 0.25 }, { attempts: 4, r: 0.999 },
    { attempts: 7, r: 0.7 }, { attempts: 1075, r: 0.5 }, { attempts: 6, r: 0 }, { attempts: 2.5, r: 0.5 }, { attempts: 1.5, r: 0.1 }, { attempts: 6.5, r: 0.1 },
  ],
  random: (rng) => ({ attempts: rng.weighted<number>([[rng.int(0, 12), 70], [rng.pick([1, 2, 3, 4, 5, 6, 7, 30, 52, 53, 100, 1023, 1024, 1100, 1e6]), 18], [maybeFrac(rng, rng.int(0, 8), 1), 12]]), r: unit(rng) }),
  call: ({ attempts, r }) => {
    const c = rngOf(r);
    const value = uploader.screenshotRetryDelayMs(attempts, c.rng);
    return plain({ value, rngCalls: c.calls() });
  },
};

const BODIES = ['', 'bad signature', 'too many requests', 'cloudinary_not_configured', 'storage_not_configured', 'x'.repeat(199), 'x'.repeat(200), 'x'.repeat(201), 'é'.repeat(250), '日本語'.repeat(80), '😀 ok', `${'a'.repeat(100)}😀${'b'.repeat(150)}`, 'line\nbreak', '"quoted"'];
const MESSAGES = ['network reset', 'no_tokens', 'ECONNRESET', 'cloudinary_not_configured', 'prefix storage_not_configured suffix', '', 'missing', 'boom'];

function genErr(rng: Rng): ErrSpec {
  const kind = rng.weighted<ErrSpec['kind']>([['unauthorized', 10], ['http', 22], ['cloudinary', 24], ['error', 24], ['plain', 8], ['text', 12]]);
  switch (kind) {
    case 'unauthorized': return { kind, message: rng.pick(MESSAGES) };
    case 'http': return { kind, path: rng.pick(['/v1/screenshots/sign', '/v1/screenshots/complete', '', '/é']), status: rng.weighted<number>([[503, 35], [rng.pick([400, 401, 404, 429, 500, 502]), 40], [maybeFrac(rng, rng.int(100, 600), 1), 5], [rng.pick([0, -1, 1e21, 1e-7]), 20]]), body: rng.pick(BODIES) };
    case 'cloudinary': return { kind, status: rng.weighted<number>([[rng.pick([400, 401, 403, 404, 408, 422, 429, 499]), 60], [rng.pick([399, 500, 502, 503, 200, 0]), 25], [rng.pick([407.5, 428.9999, 429.0000001, 399.9999999, 499.5, 500.0000001]), 15]]), body: rng.pick(BODIES) };
    case 'error': return rng.chance(0.4) ? { kind, message: rng.pick(MESSAGES), code: rng.pick(['ENOENT', 'EACCES', 'enoent', '']) } : { kind, message: rng.pick(MESSAGES) };
    case 'plain': return rng.chance(0.6) ? { kind, code: rng.pick(['ENOENT', 'EACCES']) } : { kind };
    case 'text': return { kind, text: rng.pick(MESSAGES) };
  }
}

type DecisionIn = { attempts: number; err: ErrSpec; now: number; r: number };
const decisionSpec: FnSpec<DecisionIn> = {
  module,
  fn: 'screenshotUploadFailureDecision',
  edge: () => [
    { attempts: 4, err: { kind: 'unauthorized', message: 'no_tokens' }, now: 1000, r: 0 },
    { attempts: 4, err: { kind: 'http', path: '/v1/screenshots/sign', status: 503, body: 'cloudinary_not_configured' }, now: 1000, r: 0 },
    { attempts: 1, err: { kind: 'error', message: 'network reset' }, now: 1000, r: 0.5 },
    { attempts: 4, err: { kind: 'error', message: 'network reset' }, now: 1000, r: 0.3 },
    { attempts: 0, err: { kind: 'plain', code: 'ENOENT' }, now: 1000, r: 0.3 },
    { attempts: 0, err: { kind: 'cloudinary', status: 401, body: 'bad signature' }, now: 1000, r: 0.3 },
    { attempts: 0, err: { kind: 'cloudinary', status: 429, body: 'too many requests' }, now: 1000, r: 0 },
    { attempts: 0, err: { kind: 'cloudinary', status: 408, body: 'timeout' }, now: 1791133383891.2627, r: 0.123456789 },
    { attempts: 0, err: { kind: 'cloudinary', status: 400, body: 'x'.repeat(300) }, now: 1000, r: 0.3 },
    { attempts: 2, err: { kind: 'text', text: 'storage_not_configured' }, now: 5, r: 0.3 },
    { attempts: 2, err: { kind: 'error', message: 'missing', code: 'ENOENT' }, now: 5, r: 0.3 },
  ],
  random: (rng) => ({
    attempts: rng.weighted<number>([[rng.int(0, 6), 80], [maybeFrac(rng, rng.int(0, 5), 1), 8], [rng.pick([-1, 3.5, 3.9999, 4.5, 1e9]), 12]]),
    err: genErr(rng),
    now: maybeFrac(rng, T0 + rng.int(-DAY, DAY), 0.5),
    r: unit(rng),
  }),
  call: ({ attempts, err, now, r }) => {
    const c = rngOf(r);
    const decision = uploader.screenshotUploadFailureDecision({ attempts }, buildError(err), now, c.rng);
    return plain({ decision, rngCalls: c.calls() });
  },
};

// --- AsyncLru ------------------------------------------------------------------------------------

type LruEvent = { t: 'get'; key: string } | { t: 'settle'; load: number; how: 'value' | 'null' | 'reject'; value: string };
type LruIn = { max: number; events: LruEvent[] };

async function runLru({ max, events }: LruIn): Promise<unknown> {
  let cache: AsyncLru<string>;
  try {
    cache = new AsyncLru<string>(max);
  } catch (e) {
    return { ctorError: (e as Error).message };
  }
  const loads: Array<{ resolve: (v: string | null) => void; reject: (e: Error) => void }> = [];
  const statuses: unknown[] = [];
  const steps: unknown[] = [];
  const keysOf = (): string[] => [...(cache as unknown as { values: Map<string, unknown> }).values.keys()];
  for (const e of events) {
    let started: number | null = null;
    if (e.t === 'get') {
      const index = statuses.length;
      statuses.push('pending');
      const p = cache.get(e.key, () => {
        started = loads.length;
        return new Promise<string | null>((resolve, reject) => { loads.push({ resolve, reject }); });
      });
      p.then(
        (v) => { statuses[index] = v === null ? 'null' : { value: v }; },
        () => { statuses[index] = 'error'; },
      );
    } else {
      const load = loads[e.load];
      if (load) {
        if (e.how === 'value') load.resolve(e.value);
        else if (e.how === 'null') load.resolve(null);
        else load.reject(new Error('disk error'));
      }
    }
    for (let i = 0; i < 30; i++) await Promise.resolve();
    steps.push({ started, keys: keysOf(), statuses: [...statuses] });
  }
  return { steps };
}

function genLru(rng: Rng): LruIn {
  const total = smallCount(rng, 1, 30);
  const keys = ['a', 'b', 'c', 'd', 'e'];
  const events: LruEvent[] = [];
  let loadCount = 0;
  for (let i = 0; i < total; i++) {
    if (rng.chance(0.55) || loadCount === 0) { events.push({ t: 'get', key: rng.pick(keys) }); loadCount++; }
    else events.push({ t: 'settle', load: rng.int(0, loadCount - 1), how: rng.weighted<'value' | 'null' | 'reject'>([['value', 60], ['null', 20], ['reject', 20]]), value: `v${rng.int(0, 9)}` });
  }
  return { max: rng.weighted<number>([[2, 40], [1, 20], [3, 20], [5, 10], [rng.pick([0, -1, 1.5, 2.5]), 10]]), events };
}

const lruSpec = await asyncSpec<LruIn>({
  module,
  fn: 'asyncLru',
  edge: () => [
    { max: 2, events: [{ t: 'get', key: 'a' }, { t: 'get', key: 'a' }, { t: 'settle', load: 0, how: 'value', value: 'thumb' }] },
    { max: 2, events: [{ t: 'get', key: 'a' }, { t: 'settle', load: 0, how: 'value', value: 'a' }, { t: 'get', key: 'b' }, { t: 'settle', load: 1, how: 'value', value: 'b' }, { t: 'get', key: 'c' }, { t: 'settle', load: 2, how: 'value', value: 'c' }, { t: 'get', key: 'a' }, { t: 'settle', load: 3, how: 'value', value: 'a2' }] },
    { max: 2, events: [{ t: 'get', key: 'missing' }, { t: 'settle', load: 0, how: 'null', value: '' }, { t: 'get', key: 'missing' }, { t: 'settle', load: 1, how: 'null', value: '' }, { t: 'get', key: 'failed' }, { t: 'settle', load: 2, how: 'reject', value: '' }, { t: 'get', key: 'failed' }, { t: 'settle', load: 3, how: 'reject', value: '' }] },
    { max: 0, events: [] }, { max: -1, events: [] }, { max: 1.5, events: [] },
    // eviction of a pending load, then the old load settles: it must not touch the new entry
    { max: 1, events: [{ t: 'get', key: 'a' }, { t: 'get', key: 'b' }, { t: 'get', key: 'a' }, { t: 'settle', load: 0, how: 'value', value: 'old' }, { t: 'settle', load: 2, how: 'null', value: '' }, { t: 'settle', load: 1, how: 'value', value: 'b' }] },
  ],
  random: genLru,
  run: runLru,
});

export const specs: FnSpec<any>[] = [nextDelaySpec, deferSpec, retentionSpec, shotSpec, retryDelaySpec, decisionSpec, lruSpec];
