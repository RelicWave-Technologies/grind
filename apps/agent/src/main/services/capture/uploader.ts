import { promises as fs } from 'node:fs';
import type {
  CompleteScreenshotUploadRequest,
  SignScreenshotUploadRequest,
  SignScreenshotUploadResponse,
} from '@grind/types';
import { api, HttpError, UnauthorizedError } from '../apiClient';
import { log } from '../../logger';
import { getScreenshotStore } from './index';
import type { ScreenshotRow } from './store';
import { broadcastScreenshotChange } from './events';

/** Shots uploaded per drain pass — keeps each pass short and the UI responsive. */
const BATCH = 5;
/** Background drain cadence. */
const DRAIN_INTERVAL_MS = 60_000;
const RETRY_MIN_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;
/** Bound every request so one stalled connection cannot hold the drain forever. */
const API_TIMEOUT_MS = 30_000;
const UPLOAD_TIMEOUT_MS = 120_000;

let draining = false;
let timer: NodeJS.Timeout | null = null;

export class CloudinaryUploadError extends Error {
  constructor(
    public readonly status: number,
    body: string,
  ) {
    super(`cloudinary ${status}: ${body.slice(0, 200)}`);
    this.name = 'CloudinaryUploadError';
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isStorageUnavailable(err: unknown): boolean {
  const msg = errText(err);
  return (
    (err instanceof HttpError && err.status === 503) ||
    msg.includes('cloudinary_not_configured') ||
    msg.includes('storage_not_configured')
  );
}

/** No answer at all — offline, DNS, reset, or our own timeout. Says nothing about the shot. */
function isUnreachable(err: unknown): boolean {
  return err instanceof TypeError
    || (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'));
}

function isAuthFailure(err: unknown): boolean {
  return err instanceof UnauthorizedError
    || (err instanceof HttpError && (err.status === 401 || err.status === 403));
}

function isNonCountingFailure(err: unknown): boolean {
  return isAuthFailure(err) || isStorageUnavailable(err) || isUnreachable(err);
}

function isLocalFileMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT';
}

/**
 * Only a definitive refusal of this particular shot writes it off: its file is
 * gone, or a 4xx that retrying cannot change. Server errors and outages are
 * retried with backoff for as long as the shot exists — a capped attempt count
 * is how a bad afternoon used to turn into screenshots lost for good.
 */
function isTerminalFailure(err: unknown): boolean {
  if (isLocalFileMissing(err)) return true;
  const status = err instanceof CloudinaryUploadError || err instanceof HttpError ? err.status : null;
  return status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export function screenshotRetryDelayMs(attemptsAfterFailure: number, rng: () => number = Math.random): number {
  const capped = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.max(0, attemptsAfterFailure - 1));
  if (capped <= RETRY_MIN_MS) return RETRY_MIN_MS;
  return Math.floor(RETRY_MIN_MS + rng() * (capped - RETRY_MIN_MS));
}

export type ScreenshotUploadFailureDecision =
  | { action: 'pending'; lastError: string; nextAttemptAt: number }
  | { action: 'retry'; lastError: string; nextAttemptAt: number }
  | { action: 'failed'; lastError: string };

export function screenshotUploadFailureDecision(
  row: Pick<ScreenshotRow, 'attempts'>,
  err: unknown,
// eslint-disable-next-line no-restricted-syntax -- device<->device: upload retry backoff
now = Date.now(),
  rng: () => number = Math.random,
): ScreenshotUploadFailureDecision {
  const message = errText(err);
  if (isNonCountingFailure(err)) {
    return { action: 'pending', lastError: message, nextAttemptAt: now + RETRY_MIN_MS };
  }

  const attemptsAfterFailure = row.attempts + 1;
  if (isTerminalFailure(err)) {
    return { action: 'failed', lastError: message };
  }

  return {
    action: 'retry',
    lastError: message,
    nextAttemptAt: now + screenshotRetryDelayMs(attemptsAfterFailure, rng),
  };
}

async function notifyServerFailed(row: ScreenshotRow): Promise<void> {
  await api('/v1/screenshots/complete', {
    method: 'POST',
    timeoutMs: API_TIMEOUT_MS,
    body: {
      id: row.id,
      timeEntryId: row.timeEntryId ?? null,
      displayId: row.displayId ?? null,
      capturedAt: new Date(row.capturedAt).toISOString(),
      bytes: row.bytes,
      width: row.width,
      height: row.height,
      uploadState: 'FAILED',
    } satisfies CompleteScreenshotUploadRequest,
  });
}

async function handleUploadFailure(row: ScreenshotRow, err: unknown): Promise<void> {
  const store = getScreenshotStore();
  const decision = screenshotUploadFailureDecision(row, err);

  if (decision.action === 'pending') {
    store.markPending(row.id, decision.lastError, decision.nextAttemptAt);
    broadcastScreenshotChange();
    return;
  }

  if (decision.action === 'failed') {
    store.markTerminalFailed(row.id, decision.lastError);
    broadcastScreenshotChange();
    await notifyServerFailed(row).catch((notifyErr) => {
      if (!isNonCountingFailure(notifyErr)) {
        log.debug('failed screenshot server audit update failed', { id: row.id, err: errText(notifyErr) });
      }
    });
    return;
  }

  store.markRetryScheduled(row.id, decision.lastError, decision.nextAttemptAt);
  broadcastScreenshotChange();
}

/**
 * Push one screenshot to Cloudinary: ask the API to sign the upload, POST the
 * bytes straight to Cloudinary, then tell the API where they landed. The
 * api_secret stays on the server; only a per-shot signature crosses the wire.
 */
async function uploadOne(row: ScreenshotRow): Promise<void> {
  const store = getScreenshotStore();

  try {
    // 1. Sign first — this also surfaces "not logged in" / "cloudinary off".
    const signed = await api<SignScreenshotUploadResponse>('/v1/screenshots/sign', {
      method: 'POST',
      body: { id: row.id } satisfies SignScreenshotUploadRequest,
      timeoutMs: API_TIMEOUT_MS,
    });

    store.markUploading(row.id);
    broadcastScreenshotChange();
    const buf = await fs.readFile(row.filePath);

    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'image/webp' }), `${row.id}.webp`);
    form.append('api_key', signed.apiKey);
    form.append('timestamp', String(signed.timestamp));
    form.append('public_id', signed.publicId);
    form.append('folder', signed.folder);
    form.append('signature', signed.signature);

    const res = await fetch(signed.uploadUrl, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new CloudinaryUploadError(res.status, text);
    }
    const json = (await res.json()) as { secure_url?: string; public_id?: string };
    const fullUrl = json.secure_url;
    if (!fullUrl) throw new Error('cloudinary response missing secure_url');

    // Derive a gallery thumbnail via an on-the-fly transformation.
    const thumbUrl = fullUrl.replace('/image/upload/', `/image/upload/${signed.thumbTransform}/`);

    await api('/v1/screenshots/complete', {
      method: 'POST',
      timeoutMs: API_TIMEOUT_MS,
      body: {
        id: row.id,
        timeEntryId: row.timeEntryId ?? null,
        displayId: row.displayId ?? null,
        capturedAt: new Date(row.capturedAt).toISOString(),
        s3Key: json.public_id ?? signed.publicId,
        fullUrl,
        thumbUrl,
        bytes: row.bytes,
        width: row.width,
        height: row.height,
        uploadState: 'UPLOADED',
      } satisfies CompleteScreenshotUploadRequest,
    });

    store.markUploaded(row.id, json.public_id ?? signed.publicId);
    broadcastScreenshotChange();
    log.info('screenshot uploaded', { id: row.id });
  } catch (err) {
    await handleUploadFailure(row, err);
    throw err;
  }
}

/** Try to upload freshly captured rows immediately, before older backlog. */
export async function uploadScreenshotsNow(rows: ScreenshotRow[]): Promise<void> {
  for (const row of rows) {
    try {
      await uploadOne(row);
    } catch (err) {
      if (isNonCountingFailure(err)) return;
      log.warn('screenshot upload failed', { id: row.id, err: errText(err) });
    }
  }
}

/**
 * Drain the local pending queue. No-ops when logged out or Cloudinary is
 * unconfigured (shots stay local and are retried next pass). Safe to call
 * concurrently — overlapping calls are skipped.
 */
export async function drainUploads(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    const rows = getScreenshotStore().pending(BATCH);
    for (const row of rows) {
      try {
        await uploadOne(row);
      } catch (err) {
        // Signed out, storage down, or no network: stop this pass, keep attempts untouched.
        if (isNonCountingFailure(err)) return;
        log.warn('screenshot upload failed', { id: row.id, err: errText(err) });
      }
    }
  } finally {
    draining = false;
  }
}

/** Start the periodic uploader. Idempotent. */
export function startUploader(): void {
  if (timer) return;
  void drainUploads();
  timer = setInterval(() => void drainUploads(), DRAIN_INTERVAL_MS);
}
