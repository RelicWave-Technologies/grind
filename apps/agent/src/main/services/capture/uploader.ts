import { promises as fs } from 'node:fs';
import type {
  CompleteScreenshotUploadRequest,
  SignScreenshotUploadRequest,
  SignScreenshotUploadResponse,
} from '@grind/types';
import { api, HttpError, UnauthorizedError } from '../apiClient';
import { log } from '../../logger';
import { getTimerService } from '../timer';
import { getScreenshotStore, resolveScreenshotPath } from './index';
import { ENTRY_WAIT_MS, type CaptureOwner, type ScreenshotRow } from './store';
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

let timer: NodeJS.Timeout | null = null;
/** The one upload pass allowed to run; every caller shares it. */
let inflight: Promise<void> | null = null;
/** Someone asked for a pass while one was running — run another after it. */
let rerun = false;
/** Freshly captured shots to try before the backlog. */
const preferred = new Set<string>();

/** The upload target (the server's upload endpoint or Cloudinary) refused or failed the bytes. */
export class UploadTargetError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`upload target ${status}: ${body.slice(0, 200)}`);
    this.name = 'UploadTargetError';
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isStorageUnavailable(err: unknown): boolean {
  const msg = errText(err);
  return (
    (err instanceof HttpError && err.status === 503) ||
    // The bytes go to the upload target, not through `api()`, so its 503
    // arrives as an UploadTargetError — still "storage down", not this shot.
    (err instanceof UploadTargetError && err.status === 503) ||
    msg.includes('screenshot_storage_unavailable') ||
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
  const status = err instanceof UploadTargetError || err instanceof HttpError ? err.status : null;
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
 * Push one claimed screenshot: ask the API to sign the upload, POST the bytes
 * to the upload target it names, then tell the API the shot is complete. The
 * server records where the bytes landed; the location echoed back here is only
 * kept for the local row.
 */
async function uploadOne(row: ScreenshotRow): Promise<void> {
  const store = getScreenshotStore();

  try {
    // 1. Sign first — this also surfaces "not logged in" / "storage off".
    const signed = await api<SignScreenshotUploadResponse>('/v1/screenshots/sign', {
      method: 'POST',
      body: { id: row.id } satisfies SignScreenshotUploadRequest,
      timeoutMs: API_TIMEOUT_MS,
    });

    broadcastScreenshotChange();
    const buf = await fs.readFile(resolveScreenshotPath(row.filePath));

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
      throw new UploadTargetError(res.status, text);
    }
    const json = (await res.json()) as { secure_url?: string; public_id?: string };
    const fullUrl = json.secure_url;
    if (!fullUrl) throw new Error('upload target response missing secure_url');

    // Cloudinary derives a thumbnail via an on-the-fly transformation; the
    // server's own target has none (thumbTransform is empty).
    const thumbUrl = signed.thumbTransform
      ? fullUrl.replace('/image/upload/', `/image/upload/${signed.thumbTransform}/`)
      : fullUrl;

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

/**
 * Hold a shot while its timer entry is still only local: its /complete would
 * reach the server before the entry does. After {@link ENTRY_WAIT_MS} it goes
 * up regardless and the server keeps it detached from the entry.
 */
export function shouldHoldForEntry(
  row: Pick<ScreenshotRow, 'timeEntryId' | 'capturedAt'>,
  isPendingCreate: (entryId: string) => boolean,
  now: number,
): boolean {
  if (!row.timeEntryId) return false;
  if (now - row.capturedAt >= ENTRY_WAIT_MS) return false;
  return isPendingCreate(row.timeEntryId);
}

function currentOwner(): CaptureOwner | null {
  try {
    return getTimerService().currentOwner();
  } catch {
    return null;
  }
}

type PassResult = 'done' | 'paused';

/** One pass: fresh shots first, then a batch of backlog — each claimed before it is touched. */
async function drainPass(): Promise<PassResult> {
  const owner = currentOwner();
  if (!owner) {
    preferred.clear();
    return 'done';
  }
  const store = getScreenshotStore();
  store.claimUnowned(owner);
  const timerService = getTimerService();
  // eslint-disable-next-line no-restricted-syntax -- device<->device: compared with local capture times
  const now = Date.now();

  const fresh = [...preferred]
    .map((id) => store.find(id))
    .filter((row): row is ScreenshotRow => row !== null);
  preferred.clear();
  const seen = new Set<string>();
  const rows: ScreenshotRow[] = [];
  for (const row of [...fresh, ...store.pending(owner, BATCH, now)]) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    if (row.ownerUserId !== owner.userId || row.ownerWorkspaceId !== owner.workspaceId) continue;
    rows.push(row);
  }

  for (const row of rows) {
    if (shouldHoldForEntry(row, (entryId) => timerService.isPendingCreate(entryId), now)) continue;
    // Atomic pending → uploading; anything else already has (or had) it.
    if (!store.claimForUpload(row.id)) continue;
    try {
      await uploadOne(row);
    } catch (err) {
      // Signed out, storage down, or no network: stop this pass, keep attempts untouched.
      if (isNonCountingFailure(err)) return 'paused';
      log.warn('screenshot upload failed', { id: row.id, err: errText(err) });
    }
  }
  return 'done';
}

/** Try to upload freshly captured rows promptly, ahead of older backlog. */
export function uploadScreenshotsNow(rows: ScreenshotRow[]): Promise<void> {
  for (const row of rows) preferred.add(row.id);
  return drainUploads();
}

/**
 * Drain the local pending queue. Single-flight: the capture tick, the
 * background timer and any other caller share one pass, so two passes can
 * never pick up the same shot. A call made while a pass is running schedules
 * one more pass after it. No-ops when signed out; stops early when storage or
 * the network is down (shots stay queued and are retried next pass).
 */
export function drainUploads(): Promise<void> {
  if (inflight) {
    rerun = true;
    return inflight;
  }
  inflight = (async () => {
    try {
      let result: PassResult;
      do {
        rerun = false;
        result = await drainPass();
      } while (rerun && result === 'done');
    } catch (err) {
      log.warn('screenshot upload pass failed', { err: errText(err) });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Start the periodic uploader. Idempotent. */
export function startUploader(): void {
  if (timer) return;
  void drainUploads();
  timer = setInterval(() => void drainUploads(), DRAIN_INTERVAL_MS);
}
