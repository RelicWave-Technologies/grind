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

/** Stop retrying a shot after this many failed attempts (Cloudinary/network). */
const MAX_ATTEMPTS = 5;
/** Shots uploaded per drain pass — keeps each pass short and the UI responsive. */
const BATCH = 5;
/** Background drain cadence. */
const DRAIN_INTERVAL_MS = 60_000;
const RETRY_MIN_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;

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

function isNonCountingFailure(err: unknown): boolean {
  return err instanceof UnauthorizedError || isStorageUnavailable(err);
}

function isLocalFileMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT';
}

function isTerminalFailure(err: unknown): boolean {
  if (isLocalFileMissing(err)) return true;
  if (err instanceof CloudinaryUploadError) {
    return err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
  }
  return false;
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
  now = Date.now(),
  rng: () => number = Math.random,
): ScreenshotUploadFailureDecision {
  const message = errText(err);
  if (isNonCountingFailure(err)) {
    return { action: 'pending', lastError: message, nextAttemptAt: now + RETRY_MIN_MS };
  }

  const attemptsAfterFailure = row.attempts + 1;
  if (isTerminalFailure(err) || attemptsAfterFailure >= MAX_ATTEMPTS) {
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
    return;
  }

  if (decision.action === 'failed') {
    store.markTerminalFailed(row.id, decision.lastError);
    await notifyServerFailed(row).catch((notifyErr) => {
      if (!isNonCountingFailure(notifyErr)) {
        log.debug('failed screenshot server audit update failed', { id: row.id, err: errText(notifyErr) });
      }
    });
    return;
  }

  store.markRetryScheduled(row.id, decision.lastError, decision.nextAttemptAt);
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
    });

    store.markUploading(row.id);
    const buf = await fs.readFile(row.filePath);

    const form = new FormData();
    form.append('file', new Blob([buf], { type: 'image/webp' }), `${row.id}.webp`);
    form.append('api_key', signed.apiKey);
    form.append('timestamp', String(signed.timestamp));
    form.append('public_id', signed.publicId);
    form.append('folder', signed.folder);
    form.append('signature', signed.signature);

    const res = await fetch(signed.uploadUrl, { method: 'POST', body: form });
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
        // Not logged in or storage not configured: stop this pass, keep attempts untouched.
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
