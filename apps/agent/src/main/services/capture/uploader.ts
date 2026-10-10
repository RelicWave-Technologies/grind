import { promises as fs } from 'node:fs';
import type {
  CompleteScreenshotUploadRequest,
  SignScreenshotUploadRequest,
  SignScreenshotUploadResponse,
} from '@grind/types';
import { api, HttpError, UnauthorizedError } from '../apiClient';
import { networkFetch } from '../network';
import { loadTokens } from '../tokenStore';
import { log } from '../../logger';
import { drainTimerSyncNow } from '../timer';
import { claimUnownedScreenshots, getScreenshotStore, resolveScreenshotPath } from './index';
import { currentOwner, sameOwner, type LocalOwner } from './owner';
import type { ScreenshotRow } from './store';
import { broadcastScreenshotChange } from './events';

/** Rows read from the queue at a time; a pass keeps reading pages until the queue is empty. */
const PAGE = 5;
/** A pass stops taking new shots after this long, so one pass cannot run unbounded. */
const PASS_BUDGET_MS = 60_000;
/** Background drain cadence. */
const DRAIN_INTERVAL_MS = 60_000;
const RETRY_MIN_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;
/** Ceiling for the whole-queue pause while storage (or the server) is failing. */
const OUTAGE_BACKOFF_MAX_MS = 30 * 60_000;
/** How long a pass waits for the timer backlog to sync so its shots link at once. */
const ENTRY_SYNC_WAIT_MS = 15_000;
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
/** Sign-out in progress: no pass may start, the running one stops at its next step. */
let suspended = false;
/** Aborts the running pass's byte upload when sign-out cancels it. */
let passAbort: AbortController | null = null;

/** The upload target (the server's /direct-upload behind its proxy) refused or failed the bytes. */
export class UploadTargetError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`upload target ${status}: ${body.slice(0, 200)}`);
    this.name = 'UploadTargetError';
  }
}

/**
 * The pass was stopped on purpose — the signed-in account changed under it, or
 * sign-out cancelled it. Says nothing about the shot: it goes back on the
 * queue untouched, for the account that captured it.
 */
export class UploadPassAborted extends Error {
  constructor(public readonly reason: 'owner_changed' | 'cancelled') {
    super(`upload pass aborted: ${reason}`);
    this.name = 'UploadPassAborted';
  }
}

/**
 * A whole-queue pause that doubles while storage (or the server) keeps
 * failing. Without it every pass resent a full file every minute into an
 * outage. Device clock only — compared with itself.
 */
export class OutageBackoff {
  private delayMs = 0;
  private until = 0;

  constructor(
    private readonly minMs = RETRY_MIN_MS,
    private readonly maxMs = OUTAGE_BACKOFF_MAX_MS,
  ) {}

  /** Record one more failure; returns when the queue may try again. */
  hit(now: number): number {
    this.delayMs = this.delayMs === 0 ? this.minMs : Math.min(this.delayMs * 2, this.maxMs);
    this.until = now + this.delayMs;
    return this.until;
  }

  clear(): void {
    this.delayMs = 0;
    this.until = 0;
  }

  blocked(now: number): boolean {
    return now < this.until;
  }
}

const outage = new OutageBackoff();

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function deviceNow(): number {
  // eslint-disable-next-line no-restricted-syntax -- device<->device: retry/backoff bookkeeping, never sent
  return Date.now();
}

/** The `error` code of a JSON body our API wrote, or null for anything else (a proxy's page). */
function apiErrorCode(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: unknown } | null;
    return parsed && typeof parsed.error === 'string' ? parsed.error : null;
  } catch {
    return null;
  }
}

function httpAnswer(err: unknown): { status: number; body: string } | null {
  return err instanceof UploadTargetError || err instanceof HttpError ? { status: err.status, body: err.body } : null;
}

const STORAGE_CODES = new Set([
  'screenshot_storage_unavailable',
  'screenshot_storage_not_configured',
  'storage_not_configured',
  'google_drive_not_configured',
  'public_app_url_not_configured',
]);

function isStorageUnavailable(err: unknown): boolean {
  const answer = httpAnswer(err);
  if (answer?.status === 503) return true;
  if (answer && STORAGE_CODES.has(apiErrorCode(answer.body) ?? '')) return true;
  return errText(err).includes('screenshot_storage_unavailable');
}

/** No answer at all — offline, DNS, reset, or our own timeout. Says nothing about the shot. */
function isUnreachable(err: unknown): boolean {
  return err instanceof TypeError
    || (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'));
}

function isAuthFailure(err: unknown): boolean {
  return err instanceof UnauthorizedError
    || (err instanceof HttpError && (err.status === 401 || err.status === 403))
    || (err instanceof UploadTargetError && err.status === 401);
}

function isNonCountingFailure(err: unknown): boolean {
  return isAuthFailure(err) || isStorageUnavailable(err) || isUnreachable(err);
}

function isServerError(err: unknown): boolean {
  const answer = httpAnswer(err);
  return answer !== null && answer.status >= 500;
}

function isLocalFileMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: unknown }).code === 'ENOENT';
}

/** The signed link was refused as expired or no longer valid — sign again, the shot is fine. */
const UPLOAD_LINK_CODES = new Set(['upload_token_expired', 'invalid_upload_signature', 'invalid_upload_token']);

export function isUploadLinkRejected(err: unknown): boolean {
  return err instanceof UploadTargetError && UPLOAD_LINK_CODES.has(apiErrorCode(err.body) ?? '');
}

/** API refusals that are about the attempt, not the shot: retry, never write off. */
const RETRYABLE_REFUSALS = new Set([...UPLOAD_LINK_CODES, 'screenshot_upload_not_found']);

/**
 * Only a definitive refusal of this particular shot writes it off: its file is
 * gone, or a 4xx that our API itself answered (a JSON `error` body) that is
 * neither an auth bounce nor a stale upload link. A proxy's 404/413 page, a
 * timeout, throttling and every 5xx are retried with backoff for as long as
 * the shot exists.
 */
function isTerminalFailure(err: unknown): boolean {
  if (isLocalFileMissing(err)) return true;
  const answer = httpAnswer(err);
  if (!answer) return false;
  const { status, body } = answer;
  if (status < 400 || status >= 500 || status === 408 || status === 429) return false;
  if (isAuthFailure(err)) return false;
  const code = apiErrorCode(body);
  return code !== null && !RETRYABLE_REFUSALS.has(code);
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
  now = deviceNow(),
  rng: () => number = Math.random,
  /** When the queue may try again after an outage (storage down); defaults to a minute. */
  outageUntil: number | null = null,
): ScreenshotUploadFailureDecision {
  const message = errText(err);
  if (isNonCountingFailure(err)) {
    const nextAttemptAt = isStorageUnavailable(err) && outageUntil !== null ? outageUntil : now + RETRY_MIN_MS;
    return { action: 'pending', lastError: message, nextAttemptAt };
  }
  if (isTerminalFailure(err)) return { action: 'failed', lastError: message };
  return {
    action: 'retry',
    lastError: message,
    nextAttemptAt: now + screenshotRetryDelayMs(row.attempts + 1, rng),
  };
}

/** Everything /complete carries about a shot, whatever its outcome. */
function completeBody(
  row: ScreenshotRow,
  outcome: { uploadState: 'UPLOADED'; s3Key: string; fullUrl: string } | { uploadState: 'FAILED' },
): CompleteScreenshotUploadRequest {
  return {
    id: row.id,
    // Always sent, even for an entry the server does not have yet: it keeps the
    // shot unlinked and links it when the entry arrives.
    timeEntryId: row.timeEntryId ?? null,
    displayId: row.displayId ?? null,
    capturedAt: new Date(row.capturedAt).toISOString(),
    bytes: row.bytes,
    width: row.width,
    height: row.height,
    ...outcome,
  };
}

/** The signed-in session — timer owner AND stored tokens — is still `owner`'s. */
async function ownsSession(owner: LocalOwner): Promise<boolean> {
  if (!sameOwner(owner, currentOwner())) return false;
  const tokens = await loadTokens().catch(() => null);
  return sameOwner(owner, tokens);
}

/**
 * Checked before every request: each api() call sends whichever token is
 * current, so a pass that outlived its account would upload one person's
 * screen under another's.
 */
async function assertOwner(owner: LocalOwner): Promise<void> {
  if (suspended) throw new UploadPassAborted('cancelled');
  if (!(await ownsSession(owner))) throw new UploadPassAborted('owner_changed');
}

/** The account a signed upload link was minted for, when the link says. */
function signedUserId(uploadUrl: string): string | null {
  try {
    return new URL(uploadUrl).searchParams.get('userId');
  } catch {
    return null;
  }
}

async function sign(row: ScreenshotRow, owner: LocalOwner): Promise<SignScreenshotUploadResponse> {
  await assertOwner(owner);
  const signed = await api<SignScreenshotUploadResponse>('/v1/screenshots/sign', {
    method: 'POST',
    body: { id: row.id } satisfies SignScreenshotUploadRequest,
    timeoutMs: API_TIMEOUT_MS,
  });
  // The session can switch between the check above and the request; the link
  // names who it was signed for, and the bytes must not land in that account.
  const signedFor = signedUserId(signed.uploadUrl);
  if (signedFor !== null && signedFor !== owner.userId) throw new UploadPassAborted('owner_changed');
  return signed;
}

/** POST the bytes to the signed link, over the OS network stack (corporate proxies/TLS inspection). */
async function sendBytes(
  signed: SignScreenshotUploadResponse,
  row: ScreenshotRow,
  buf: Buffer,
  cancel: AbortSignal,
): Promise<{ fileId: string; url: string }> {
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'image/webp' }), `${row.id}.webp`);
  const res = await networkFetch(signed.uploadUrl, {
    method: 'POST',
    body: form,
    credentials: 'omit',
    signal: AbortSignal.any([AbortSignal.timeout(UPLOAD_TIMEOUT_MS), cancel]),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new UploadTargetError(res.status, text);
  }
  const json = (await res.json()) as { secure_url?: string; public_id?: string };
  if (!json.secure_url) throw new Error('upload target response missing secure_url');
  return { fileId: json.public_id ?? signed.publicId, url: json.secure_url };
}

/**
 * Push one claimed screenshot: ask the API to sign the upload, POST the bytes
 * to the link it names, then tell the API the shot is complete. The owner is
 * re-checked before each step. An expired or rejected link is re-signed once
 * straight away rather than costing the shot an attempt.
 */
async function uploadOne(row: ScreenshotRow, owner: LocalOwner, cancel: AbortSignal): Promise<void> {
  let signed = await sign(row, owner);
  broadcastScreenshotChange();
  const buf = await fs.readFile(resolveScreenshotPath(row.filePath));

  await assertOwner(owner);
  let uploaded: { fileId: string; url: string };
  try {
    uploaded = await sendBytes(signed, row, buf, cancel);
  } catch (err) {
    if (!isUploadLinkRejected(err)) throw err;
    log.info('screenshot upload link rejected; signing again', { id: row.id, err: errText(err) });
    signed = await sign(row, owner);
    await assertOwner(owner);
    uploaded = await sendBytes(signed, row, buf, cancel);
  }

  await assertOwner(owner);
  await api('/v1/screenshots/complete', {
    method: 'POST',
    timeoutMs: API_TIMEOUT_MS,
    body: completeBody(row, { uploadState: 'UPLOADED', s3Key: uploaded.fileId, fullUrl: uploaded.url }),
  });

  getScreenshotStore().markUploaded(row.id, uploaded.fileId);
  outage.clear();
  broadcastScreenshotChange();
  log.info('screenshot uploaded', { id: row.id });
}

async function notifyServerFailed(row: ScreenshotRow, owner: LocalOwner): Promise<void> {
  await assertOwner(owner);
  await api('/v1/screenshots/complete', {
    method: 'POST',
    timeoutMs: API_TIMEOUT_MS,
    body: completeBody(row, { uploadState: 'FAILED' }),
  });
}

/** Record what a failed upload means for the shot; `stop` ends the pass. */
async function handleUploadFailure(row: ScreenshotRow, err: unknown, owner: LocalOwner): Promise<'stop' | 'continue'> {
  const store = getScreenshotStore();

  // The account changed (or sign-out cancelled the pass): whatever the error —
  // a 409 screenshot_id_conflict from the other account included — it is not
  // this shot's fault. Back on the queue, no attempt spent, nothing written off.
  if (err instanceof UploadPassAborted || suspended || !(await ownsSession(owner))) {
    store.markPending(row.id, row.lastError, null);
    broadcastScreenshotChange();
    log.info('screenshot upload pass stopped: account changed or signing out', { id: row.id, err: errText(err) });
    return 'stop';
  }

  const now = deviceNow();
  const outageUntil = isStorageUnavailable(err) || isServerError(err) ? outage.hit(now) : null;
  const decision = screenshotUploadFailureDecision(row, err, now, Math.random, outageUntil);

  if (decision.action === 'pending') {
    store.markPending(row.id, decision.lastError, decision.nextAttemptAt);
    broadcastScreenshotChange();
    return 'stop';
  }

  if (decision.action === 'failed') {
    store.markTerminalFailed(row.id, decision.lastError);
    broadcastScreenshotChange();
    log.warn('screenshot written off', { id: row.id, err: decision.lastError });
    await notifyServerFailed(row, owner).catch((notifyErr) => {
      log.debug('failed screenshot server audit update failed', { id: row.id, err: errText(notifyErr) });
    });
    return 'continue';
  }

  store.markRetryScheduled(row.id, decision.lastError, decision.nextAttemptAt);
  broadcastScreenshotChange();
  log.warn('screenshot upload failed', { id: row.id, err: decision.lastError });
  // A server error is about the server, not this shot: stop hammering it.
  return isServerError(err) ? 'stop' : 'continue';
}

/**
 * Let the timer backlog reach the server first, so the entries these shots
 * name exist when they arrive and link straight away. Bounded: a stalled
 * timer sync must not hold the screenshot queue.
 */
async function waitForTimerSync(): Promise<void> {
  let wait: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(() => drainTimerSyncNow('manual')).catch(() => undefined),
      new Promise<void>((resolve) => {
        wait = setTimeout(resolve, ENTRY_SYNC_WAIT_MS);
        wait.unref?.();
      }),
    ]);
  } finally {
    if (wait) clearTimeout(wait);
  }
}

type PassResult = 'done' | 'paused';

/**
 * One pass: fresh shots first, then the backlog page by page until the queue
 * is empty or the pass has used its time budget. Each shot is claimed before
 * it is touched.
 */
async function drainPass(): Promise<PassResult> {
  if (suspended) return 'done';
  const owner = currentOwner();
  if (!owner) {
    preferred.clear();
    return 'done';
  }
  if (outage.blocked(deviceNow())) return 'paused';

  await waitForTimerSync();
  if (suspended || !sameOwner(owner, currentOwner())) return 'paused';

  claimUnownedScreenshots(owner);
  const store = getScreenshotStore();
  const abort = new AbortController();
  passAbort = abort;
  const startedAt = deviceNow();
  const seen = new Set<string>();
  let fresh = [...preferred];
  preferred.clear();

  try {
    while (deviceNow() - startedAt < PASS_BUDGET_MS) {
      const page: ScreenshotRow[] = [];
      const candidates = [
        ...fresh.map((id) => store.find(id)).filter((row): row is ScreenshotRow => row !== null),
        ...store.pending(owner, PAGE, deviceNow()),
      ];
      fresh = [];
      for (const row of candidates) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        if (row.ownerUserId !== owner.userId || row.ownerWorkspaceId !== owner.workspaceId) continue;
        page.push(row);
      }
      if (page.length === 0) return 'done';

      for (const row of page) {
        // Atomic pending → uploading; anything else already has (or had) it.
        if (!store.claimForUpload(row.id)) continue;
        try {
          await uploadOne(row, owner, abort.signal);
        } catch (err) {
          if ((await handleUploadFailure(row, err, owner)) === 'stop') return 'paused';
        }
      }
    }
    log.info('screenshot upload pass used its time budget; continuing next pass');
    return 'done';
  } finally {
    if (passAbort === abort) passAbort = null;
  }
}

/** Try to upload freshly captured rows promptly, ahead of older backlog. */
export function uploadScreenshotsNow(rows: ScreenshotRow[]): Promise<void> {
  if (suspended) return Promise.resolve();
  for (const row of rows) preferred.add(row.id);
  return drainUploads();
}

/**
 * Drain the local pending queue. Single-flight: the capture tick, the
 * background timer and any other caller share one pass, so two passes can
 * never pick up the same shot. A call made while a pass is running schedules
 * one more pass after it. No-ops when signed out or signing out; stops early
 * when storage or the network is down (shots stay queued and are retried).
 */
export function drainUploads(): Promise<void> {
  if (suspended) return inflight ?? Promise.resolve();
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
      } while (rerun && result === 'done' && !suspended);
    } catch (err) {
      log.warn('screenshot upload pass failed', { err: errText(err) });
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/**
 * Sign-out: stop the running pass at its next step (aborting a byte upload in
 * flight) and wait for it to finish, then refuse new passes until
 * {@link resumeUploads}. The interrupted shot goes back on the queue untouched.
 */
export async function stopUploads(): Promise<void> {
  suspended = true;
  preferred.clear();
  passAbort?.abort();
  await inflight;
}

/** Allow passes again once sign-out has finished (they no-op until someone signs in). */
export function resumeUploads(): void {
  suspended = false;
}

/** Start the periodic uploader. Idempotent. */
export function startUploader(): void {
  if (timer) return;
  void drainUploads();
  timer = setInterval(() => void drainUploads(), DRAIN_INTERVAL_MS);
}
