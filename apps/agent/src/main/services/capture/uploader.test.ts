import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpError, UnauthorizedError } from '../apiClient';
import type * as ApiClientModule from '../apiClient';
import type * as NetworkModule from '../network';
import type * as UploaderModule from './uploader';
import { ScreenshotStore, type ScreenshotRow } from './store';
import {
  OutageBackoff,
  UploadTargetError,
  isUploadLinkRejected,
  screenshotRetryDelayMs,
  screenshotUploadFailureDecision,
} from './uploader';

describe('screenshot uploader retry decisions', () => {
  it('uses capped exponential backoff with a one-minute floor', () => {
    expect(screenshotRetryDelayMs(1, () => 0)).toBe(60_000);
    expect(screenshotRetryDelayMs(2, () => 0.5)).toBe(90_000);
    expect(screenshotRetryDelayMs(20, () => 1)).toBe(3_600_000);
  });

  it('does not consume attempts for auth failures', () => {
    const decision = screenshotUploadFailureDecision({ attempts: 4 }, new UnauthorizedError('no_tokens'), 1_000, () => 0);
    expect(decision).toEqual({ action: 'pending', lastError: 'no_tokens', nextAttemptAt: 61_000 });
  });

  it('does not consume attempts when storage is not configured, and waits out the outage', () => {
    const decision = screenshotUploadFailureDecision(
      { attempts: 4 },
      new HttpError('/v1/screenshots/sign', 503, '{"error":"screenshot_storage_not_configured"}'),
      1_000,
      () => 0,
      500_000,
    );
    expect(decision).toMatchObject({ action: 'pending', nextAttemptAt: 500_000 });
  });

  it('schedules retryable failures below the cap', () => {
    const decision = screenshotUploadFailureDecision({ attempts: 1 }, new Error('network reset'), 1_000, () => 0.5);
    expect(decision).toEqual({ action: 'retry', lastError: 'network reset', nextAttemptAt: 91_000 });
  });

  it('never writes a shot off for a server error, however many times it failed', () => {
    const decision = screenshotUploadFailureDecision(
      { attempts: 40 },
      new HttpError('/v1/screenshots/complete', 500, '{"error":"internal_error"}'),
      1_000,
      () => 0,
    );
    expect(decision).toMatchObject({ action: 'retry', nextAttemptAt: 61_000 });
  });

  it('does not consume attempts while offline or timed out', () => {
    for (const err of [new TypeError('fetch failed'), Object.assign(new Error('timed out'), { name: 'TimeoutError' })]) {
      expect(screenshotUploadFailureDecision({ attempts: 3 }, err, 1_000)).toMatchObject({ action: 'pending' });
    }
  });

  it('treats a definitive API refusal as terminal but an auth bounce as waiting', () => {
    expect(screenshotUploadFailureDecision({ attempts: 0 }, new HttpError('/v1/screenshots/sign', 409, '{"error":"screenshot_id_conflict"}'), 1_000))
      .toMatchObject({ action: 'failed' });
    expect(screenshotUploadFailureDecision({ attempts: 0 }, new HttpError('/v1/screenshots/sign', 401, '{"error":"unauthorized"}'), 1_000))
      .toMatchObject({ action: 'pending' });
  });

  it('treats a missing local file and an API-answered 4xx from the upload target as terminal', () => {
    expect(screenshotUploadFailureDecision({ attempts: 0 }, { code: 'ENOENT', message: 'missing' }, 1_000))
      .toMatchObject({ action: 'failed' });
    expect(screenshotUploadFailureDecision({ attempts: 0 }, new UploadTargetError(400, '{"error":"missing_file"}'), 1_000))
      .toMatchObject({ action: 'failed' });
  });

  it('retries a proxy 404/413 page instead of writing the shot off', () => {
    for (const err of [
      new UploadTargetError(413, '<html><body>413 Request Entity Too Large</body></html>'),
      new UploadTargetError(404, '<html>Not Found</html>'),
      new HttpError('/v1/screenshots/complete', 404, 'Not Found'),
    ]) {
      expect(screenshotUploadFailureDecision({ attempts: 0 }, err, 1_000, () => 0)).toMatchObject({ action: 'retry' });
    }
  });

  it('never writes a shot off for an expired or rejected upload link', () => {
    for (const code of ['upload_token_expired', 'invalid_upload_signature']) {
      const err = new UploadTargetError(403, JSON.stringify({ error: code }));
      expect(isUploadLinkRejected(err)).toBe(true);
      expect(screenshotUploadFailureDecision({ attempts: 0 }, err, 1_000, () => 0)).toMatchObject({ action: 'retry' });
    }
  });

  it('keeps throttling-style upload-target 4xx responses retryable', () => {
    const decision = screenshotUploadFailureDecision({ attempts: 0 }, new UploadTargetError(429, 'too many requests'), 1_000, () => 0);
    expect(decision).toEqual({ action: 'retry', lastError: 'upload target 429: too many requests', nextAttemptAt: 61_000 });
  });

  it('reads a 503 from the upload target as storage unavailable — no attempt spent', () => {
    const decision = screenshotUploadFailureDecision(
      { attempts: 2 },
      new UploadTargetError(503, '{"error":"screenshot_storage_unavailable"}'),
      1_000,
      () => 0,
    );
    expect(decision).toMatchObject({ action: 'pending', nextAttemptAt: 61_000 });
  });
});

describe('OutageBackoff', () => {
  it('doubles the whole-queue pause while the outage lasts, capped, and clears on success', () => {
    const b = new OutageBackoff(60_000, 240_000);
    expect(b.hit(0)).toBe(60_000);
    expect(b.blocked(59_999)).toBe(true);
    expect(b.hit(60_000)).toBe(180_000);
    expect(b.hit(180_000)).toBe(420_000);
    expect(b.hit(420_000)).toBe(660_000); // capped at 240s
    b.clear();
    expect(b.blocked(420_001)).toBe(false);
  });
});

// --- The drain itself, against a real local queue and a fake server ---------

const ALICE = { userId: 'alice', workspaceId: 'w1' };
const BOB = { userId: 'bob', workspaceId: 'w1' };

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  fetch: vi.fn(),
  loadTokens: vi.fn(),
  drainTimer: vi.fn(),
  claim: vi.fn(),
  owner: null as { userId: string; workspaceId: string } | null,
  store: null as unknown,
  root: '',
}));

vi.mock('../apiClient', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiClientModule>()),
  api: mocks.api,
}));
vi.mock('../network', async (importOriginal) => ({
  ...(await importOriginal<typeof NetworkModule>()),
  networkFetch: mocks.fetch,
}));
vi.mock('../tokenStore', () => ({ loadTokens: mocks.loadTokens }));
vi.mock('../timer', () => ({
  drainTimerSyncNow: mocks.drainTimer,
  getTimerService: () => ({ currentOwner: () => mocks.owner }),
}));
vi.mock('./index', () => ({
  getScreenshotStore: () => mocks.store,
  resolveScreenshotPath: (p: string) => path.join(mocks.root, p),
  claimUnownedScreenshots: mocks.claim,
}));
vi.mock('./events', () => ({ broadcastScreenshotChange: vi.fn() }));
vi.mock('../../logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

type Uploader = typeof UploaderModule;

function signIn(owner: { userId: string; workspaceId: string } | null): void {
  mocks.owner = owner;
  mocks.loadTokens.mockResolvedValue(owner ? { accessToken: 'a', refreshToken: 'r', ...owner } : null);
}

function shot(id: string, over: Partial<ScreenshotRow> = {}): ScreenshotRow {
  const filePath = `2026-10-10/${id}.webp`;
  mkdirSync(path.join(mocks.root, '2026-10-10'), { recursive: true });
  writeFileSync(path.join(mocks.root, filePath), `bytes-of-${id}`);
  return {
    id,
    timeEntryId: 'entry-local',
    displayId: 'd1',
    capturedAt: 1_000 + Number(id.replace(/\D/gu, '') || 0),
    filePath,
    bytes: 10,
    width: 1,
    height: 1,
    uploadState: 'pending',
    attempts: 0,
    s3Key: null,
    lastError: null,
    nextAttemptAt: null,
    failedAt: null,
    ownerUserId: ALICE.userId,
    ownerWorkspaceId: ALICE.workspaceId,
    ...over,
  };
}

function store(): ScreenshotStore {
  return mocks.store as ScreenshotStore;
}

const okUpload = (id: string) =>
  new Response(JSON.stringify({ secure_url: `https://api.test/v1/screenshots/assets/f-${id}`, public_id: `f-${id}` }), {
    status: 200,
  });

function idFromUrl(url: string): string {
  return new URL(url).searchParams.get('id') ?? '';
}

/** A server that signs for whoever the session currently is and accepts everything. */
function healthyServer(): void {
  mocks.api.mockImplementation(async (p: string, opts: { body: { id: string } }) => {
    if (p === '/v1/screenshots/sign') {
      return {
        cloudName: 'google-drive',
        apiKey: 'grind',
        uploadUrl: `https://api.test/v1/screenshots/direct-upload?userId=${mocks.owner?.userId}&id=${opts.body.id}&expires=1&sig=s`,
        timestamp: 1,
        signature: 's',
        publicId: opts.body.id,
        folder: 'f',
        thumbTransform: '',
      };
    }
    if (p === '/v1/screenshots/complete') return { id: opts.body.id, uploadState: 'UPLOADED' };
    throw new Error(`unexpected ${p}`);
  });
  mocks.fetch.mockImplementation(async (url: string) => okUpload(idFromUrl(url)));
}

const completeCalls = () => mocks.api.mock.calls.filter((c) => c[0] === '/v1/screenshots/complete');

describe('draining the screenshot queue', () => {
  let uploader: Uploader;
  /** The HttpError class of the fresh module graph (resetModules makes a new one). */
  let Http: typeof HttpError;

  beforeEach(async () => {
    vi.resetModules();
    mocks.api.mockReset();
    mocks.fetch.mockReset();
    mocks.loadTokens.mockReset();
    mocks.drainTimer.mockReset().mockResolvedValue(undefined);
    mocks.claim.mockReset();
    mocks.root = mkdtempSync(path.join(tmpdir(), 'grind-uploader-'));
    mocks.store = new ScreenshotStore(new Database(':memory:'));
    signIn(ALICE);
    healthyServer();
    uploader = await import('./uploader');
    Http = (await import('../apiClient')).HttpError;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uploads over the OS network stack with only the file, and drains the whole queue in one pass', async () => {
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    for (let i = 0; i < 12; i++) store().insert(shot(`s${i}`));

    await uploader.drainUploads();

    expect(globalFetch).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(12);
    const init = mocks.fetch.mock.calls[0]![1] as RequestInit;
    expect([...(init.body as FormData).keys()]).toEqual(['file']); // no Cloudinary-era fields
    expect(init.credentials).toBe('omit');
    expect(store().rangeSummary(ALICE, 0, Number.MAX_SAFE_INTEGER)).toEqual({ pending: 0, uploaded: 12, failed: 0 });
    expect(mocks.claim).toHaveBeenCalledWith(ALICE);
  });

  it('sends a shot of a not-yet-synced entry straight away, with its entry id, after a timer sync', async () => {
    store().insert(shot('s1', { timeEntryId: 'entry-local', capturedAt: 1_000 }));

    await uploader.drainUploads();

    expect(mocks.drainTimer).toHaveBeenCalled();
    expect(mocks.drainTimer.mock.invocationCallOrder[0]).toBeLessThan(mocks.api.mock.invocationCallOrder[0]!);
    const body = completeCalls()[0]![1].body as Record<string, unknown>;
    expect(body).toMatchObject({ id: 's1', timeEntryId: 'entry-local', uploadState: 'UPLOADED', s3Key: 'f-s1' });
    expect(body).not.toHaveProperty('thumbUrl');
    expect(store().find('s1')?.uploadState).toBe('uploaded');
  });

  it('stops after its time budget and leaves the rest for the next pass', async () => {
    for (let i = 0; i < 12; i++) store().insert(shot(`s${i}`));
    let clock = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (clock += 7_000));

    await uploader.drainUploads();

    const { uploaded } = store().rangeSummary(ALICE, 0, Number.MAX_SAFE_INTEGER);
    expect(uploaded).toBeGreaterThan(0);
    expect(uploaded).toBeLessThan(12);
  });

  it('puts a shot back untouched when the account changes mid-upload', async () => {
    store().insert(shot('s1'));
    store().insert(shot('s2'));
    mocks.fetch.mockImplementation(async (url: string) => {
      signIn(BOB); // switched while the bytes were going up
      return okUpload(idFromUrl(url));
    });

    await uploader.drainUploads();

    expect(completeCalls()).toHaveLength(0);
    expect(store().find('s1')).toMatchObject({ uploadState: 'pending', attempts: 0, nextAttemptAt: null });
    expect(store().find('s2')).toMatchObject({ uploadState: 'pending', attempts: 0 });
  });

  it('does not write a shot off for a 409 from /complete when the session changed under it', async () => {
    store().insert(shot('s1'));
    const sign = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation(async (p: string, opts: { body: { id: string } }) => {
      if (p !== '/v1/screenshots/complete') return sign(p, opts);
      signIn(BOB); // the request went out with Bob's token
      throw new Http(p, 409, '{"error":"screenshot_id_conflict"}');
    });

    await uploader.drainUploads();

    expect(store().find('s1')).toMatchObject({ uploadState: 'pending', attempts: 0 });
  });

  it('still writes off a 409 conflict when the account did not change', async () => {
    store().insert(shot('s1'));
    const sign = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation(async (p: string, opts: { body: { id: string } }) => {
      if (p === '/v1/screenshots/sign') throw new Http(p, 409, '{"error":"screenshot_id_conflict"}');
      return sign(p, opts);
    });

    await uploader.drainUploads();

    expect(store().find('s1')?.uploadState).toBe('failed');
    expect(completeCalls()[0]![1].body).toMatchObject({ id: 's1', uploadState: 'FAILED', timeEntryId: 'entry-local' });
  });

  it('never uploads bytes through a link signed for another account', async () => {
    store().insert(shot('s1'));
    const sign = mocks.api.getMockImplementation()!;
    mocks.api.mockImplementation(async (p: string, opts: { body: { id: string } }) => {
      const out = await sign(p, opts);
      if (p === '/v1/screenshots/sign') out.uploadUrl = out.uploadUrl.replace('userId=alice', 'userId=bob');
      return out;
    });

    await uploader.drainUploads();

    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(store().find('s1')).toMatchObject({ uploadState: 'pending', attempts: 0 });
  });

  it('signs again when the upload link has expired, without spending an attempt', async () => {
    store().insert(shot('s1'));
    mocks.fetch
      .mockResolvedValueOnce(new Response('{"error":"upload_token_expired"}', { status: 403 }))
      .mockImplementation(async (url: string) => okUpload(idFromUrl(url)));

    await uploader.drainUploads();

    expect(mocks.api.mock.calls.filter((c) => c[0] === '/v1/screenshots/sign')).toHaveLength(2);
    expect(store().find('s1')).toMatchObject({ uploadState: 'uploaded', attempts: 0 });
  });

  it('retries a proxy 413 page later instead of writing the shot off', async () => {
    store().insert(shot('s1'));
    mocks.fetch.mockResolvedValue(new Response('<html>413 Request Entity Too Large</html>', { status: 413 }));

    await uploader.drainUploads();

    expect(store().find('s1')).toMatchObject({ uploadState: 'pending', attempts: 1 });
  });

  it('backs the whole queue off while storage is down instead of resending every minute', async () => {
    store().insert(shot('s1'));
    store().insert(shot('s2'));
    mocks.fetch.mockResolvedValue(new Response('{"error":"screenshot_storage_unavailable"}', { status: 503 }));

    await uploader.drainUploads();
    expect(mocks.fetch).toHaveBeenCalledTimes(1); // the pass stops at the first outage answer
    expect(store().find('s1')).toMatchObject({ uploadState: 'pending', attempts: 0 });

    await uploader.drainUploads(); // the next tick, inside the backoff window
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it('sign-out cancels an in-flight pass and waits for it; no pass runs until resumed', async () => {
    store().insert(shot('s1'));
    let started!: () => void;
    const uploading = new Promise<void>((resolve) => (started = resolve));
    mocks.fetch.mockImplementation((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        started();
        init.signal!.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      }),
    );

    const pass = uploader.drainUploads();
    await uploading;
    await uploader.stopUploads();
    await pass;

    expect(store().find('s1')).toMatchObject({ uploadState: 'pending', attempts: 0 });
    mocks.fetch.mockClear();
    await uploader.drainUploads();
    expect(mocks.fetch).not.toHaveBeenCalled();

    uploader.resumeUploads();
    healthyServer();
    await uploader.drainUploads();
    expect(store().find('s1')?.uploadState).toBe('uploaded');
  });
});
