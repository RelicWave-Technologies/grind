import { promises as fs } from 'node:fs';
import type {
  CompleteScreenshotUploadRequest,
  SignScreenshotUploadRequest,
  SignScreenshotUploadResponse,
} from '@grind/types';
import { api, UnauthorizedError } from '../apiClient';
import { log } from '../../logger';
import { getScreenshotStore } from './index';
import type { ScreenshotRow } from './store';

/** Stop retrying a shot after this many failed attempts (Cloudinary/network). */
const MAX_ATTEMPTS = 5;
/** Shots uploaded per drain pass — keeps each pass short and the UI responsive. */
const BATCH = 5;
/** Background drain cadence. */
const DRAIN_INTERVAL_MS = 60_000;

let draining = false;
let timer: NodeJS.Timeout | null = null;

/**
 * Push one screenshot to Cloudinary: ask the API to sign the upload, POST the
 * bytes straight to Cloudinary, then tell the API where they landed. The
 * api_secret stays on the server; only a per-shot signature crosses the wire.
 */
async function uploadOne(row: ScreenshotRow): Promise<void> {
  const store = getScreenshotStore();

  // 1. Sign first — this also surfaces "not logged in" / "cloudinary off"
  //    before we flip the row to `uploading`, so those cases leave it pending.
  const signed = await api<SignScreenshotUploadResponse>('/v1/screenshots/sign', {
    method: 'POST',
    body: { id: row.id } satisfies SignScreenshotUploadRequest,
  });

  store.markUploading(row.id);
  try {
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
      throw new Error(`cloudinary ${res.status}: ${text.slice(0, 200)}`);
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
    store.markFailed(row.id);
    throw err;
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
    const rows = getScreenshotStore()
      .pending(BATCH)
      .filter((r) => r.attempts < MAX_ATTEMPTS);
    for (const row of rows) {
      try {
        await uploadOne(row);
      } catch (err) {
        if (err instanceof UnauthorizedError) return; // not logged in — stop, retry later
        const msg = String(err);
        // Cloudinary not wired up yet: stop the whole pass, keep shots local.
        if (msg.includes('cloudinary_not_configured') || msg.includes(' 503')) return;
        log.warn('screenshot upload failed', { id: row.id, err: msg });
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
