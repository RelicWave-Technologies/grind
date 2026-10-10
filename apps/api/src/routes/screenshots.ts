import crypto from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { prisma } from '@grind/db';
import {
  CompleteScreenshotUploadRequest,
  SignScreenshotUploadRequest,
  type CompleteScreenshotUploadResponse,
  type SignScreenshotUploadResponse,
} from '@grind/types';
import { requireAccessToken } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { isCloudinaryConfigured } from '../lib/cloudinary';
import {
  downloadScreenshotFromDrive,
  getDriveFileName,
  isGoogleDriveConfigured,
  screenshotDriveFileName,
  trashScreenshotInDrive,
  uploadScreenshotToDrive,
} from '../lib/googleDrive';
import { dashboardOrigins, env } from '../env';
import { logger } from '../logger';
import { getWorkspaceTimezone } from '../workspace/timezone';
import { attachScope } from '../middleware/scope';
import { classifyEntryClaims, linkClaimsIfEntriesArrived } from '../timeEntries/claimedEvidence';

export const screenshotsRouter = Router();

const MAX_SCREENSHOT_UPLOAD_BYTES = 8 * 1024 * 1024;
const DRIVE_UPLOAD_TTL_SECONDS = 10 * 60;
/** Legacy Cloudinary rows: never wait on a remote image longer than this. */
const REMOTE_IMAGE_TIMEOUT_MS = 20_000;

/**
 * Did the upload fail because the storage behind us is unhappy?
 *
 * Every `google_drive_*` failure qualifies, whatever the status Drive gave:
 * a 403 quota, a 404 folder, a 401 key, a 500 outage. None of them says the
 * agent sent something wrong, so none of them should cost the agent an attempt.
 */
function isDriveFailure(err: unknown): boolean {
  return err instanceof Error
    && (err.message.startsWith('google_drive_') || err.message.startsWith('google_oauth_'));
}

screenshotsRouter.post('/direct-upload', async (req, res, next) => {
  try {
    if (!isGoogleDriveConfigured()) return res.status(503).json({ error: 'google_drive_not_configured' });
    const token = verifyDriveUploadToken(req.query as Record<string, unknown>);
    if (!token.ok) return res.status(token.status).json({ error: token.error });
    const existing = await prisma.screenshot.findUnique({
      where: { id: token.id },
      select: { userId: true, s3Key: true, capturedAt: true },
    });
    if (existing && existing.userId !== token.userId) {
      return res.status(409).json({ error: 'screenshot_id_conflict' });
    }

    // Idempotent: a retry of a shot the server already holds — the agent timed
    // out waiting for our answer, or crashed before /complete — gets the file
    // we stored, not a second copy in Drive.
    if (existing?.s3Key) return sendDriveUploadResult(res, existing.s3Key);

    const raw = await readRequestBody(req, MAX_SCREENSHOT_UPLOAD_BYTES);
    const file = extractMultipartFile(raw, String(req.headers['content-type'] ?? ''));
    if (!file || file.byteLength === 0) return res.status(400).json({ error: 'missing_file' });

    // File under the month the shot was TAKEN in, read in the workspace's own
    // timezone. Without this the upload lands in the flat root folder, which is
    // how a shared drive reaches its 400,000-item ceiling with nothing anybody
    // can delete a month at a time.
    const capturedAt = existing?.capturedAt ?? capturedAtFromScreenshotId(token.id) ?? new Date();
    const tz = await userTimezone(token.userId);
    let uploaded: { fileId: string };
    try {
      uploaded = await uploadScreenshotToDrive({
        data: file,
        filename: screenshotDriveFileName(token.userId, token.id),
        capturedAt,
        tz,
      });
    } catch (err) {
      if (!isDriveFailure(err)) throw err;
      // 503, not 500. Every one of these is our problem — a full drive, a bad
      // folder id, an expired key — and none of them is something the agent
      // can fix by trying a different file. The agent reads a 503 as "storage
      // unavailable" and keeps the shot queued without spending an attempt.
      logger.error({ err, screenshotId: token.id }, 'screenshot storage unavailable');
      return res.status(503).json({ error: 'screenshot_storage_unavailable' });
    }

    // Record the file id HERE, server-side, keyed by the signed (user, shot).
    // /complete and the image endpoints trust this record, never a file id or
    // URL the client sends back.
    const recorded = await recordDriveFile({
      userId: token.userId,
      screenshotId: token.id,
      fileId: uploaded.fileId,
      capturedAt,
    });
    if (recorded !== uploaded.fileId) {
      // A concurrent upload of the same shot recorded its file first. Keep
      // theirs and drop the copy we just made.
      void trashScreenshotInDrive(uploaded.fileId).catch((err: unknown) => {
        logger.warn({ err, screenshotId: token.id }, 'duplicate screenshot upload could not be trashed');
      });
    }
    return sendDriveUploadResult(res, recorded);
  } catch (err) {
    next(err);
  }
});

screenshotsRouter.use(requireAccessToken);

screenshotsRouter.get('/:id/image', attachScope, async (req, res, next) => {
  try {
    if (!req.user || !req.scope) return res.status(401).json({ error: 'unauthorized' });
    const variant = screenshotImageVariant(req.query.variant);
    if (!variant) return res.status(400).json({ error: 'invalid_variant' });
    const screenshotId = req.params.id;
    if (!screenshotId) return res.status(404).json({ error: 'screenshot_not_found' });

    const row = await prisma.screenshot.findUnique({
      where: { id: screenshotId },
      select: {
        id: true,
        userId: true,
        uploadState: true,
        deletedAt: true,
        s3Key: true,
        fullUrl: true,
        thumbUrl: true,
      },
    });
    if (!row || row.deletedAt || row.uploadState !== 'UPLOADED') {
      return res.status(404).json({ error: 'screenshot_not_found' });
    }
    if (!req.scope.userIds.includes(row.userId)) return res.status(403).json({ error: 'forbidden' });

    const data = await loadScreenshotImage(row, variant);
    if (!data) return res.status(404).json({ error: 'screenshot_not_found' });
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(data);
  } catch (err) {
    next(err);
  }
});

screenshotsRouter.get('/assets/:fileId', attachScope, async (req, res, next) => {
  try {
    if (!req.user || !req.scope) return res.status(401).json({ error: 'unauthorized' });
    const fileId = req.params.fileId;
    if (!fileId) return res.status(400).json({ error: 'missing_file_id' });
    if (!isGoogleDriveConfigured()) return res.status(404).json({ error: 'screenshot_not_found' });
    // Several rows can name the same file id — only one of them can be the
    // shot the file was uploaded for. Serve the file only through a row the
    // caller may see AND that the file itself names as its owner.
    const rows = await prisma.screenshot.findMany({
      where: { s3Key: fileId, deletedAt: null, uploadState: 'UPLOADED' },
      select: { id: true, userId: true },
      take: 10,
    });
    const visible = rows.filter((row) => req.scope!.userIds.includes(row.userId));
    if (rows.length > 0 && visible.length === 0) return res.status(403).json({ error: 'forbidden' });
    for (const row of visible) {
      if (!(await driveFileBelongsTo(fileId, row.userId, row.id))) continue;
      const data = await downloadScreenshotFromDrive(fileId);
      res.setHeader('Content-Type', 'image/webp');
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.send(data);
    }
    return res.status(404).json({ error: 'screenshot_not_found' });
  } catch (err) {
    next(err);
  }
});

/**
 * Mint a short-lived upload target on Google Drive. The response keeps the
 * Cloudinary-shaped contract the agent was built against, so installed agents
 * upload without a desktop rebuild.
 */
screenshotsRouter.post('/sign', validate(SignScreenshotUploadRequest, 'body'), async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const body = req.body as SignScreenshotUploadRequest;
    if (!(await canWriteScreenshot(req.user.sub, body.id))) {
      return res.status(409).json({ error: 'screenshot_id_conflict' });
    }

    if (isGoogleDriveConfigured()) {
      if (!publicAppUrl()) return res.status(503).json({ error: 'public_app_url_not_configured' });
      const signed = signDriveUpload(req.user.sub, body.id);
      const response: SignScreenshotUploadResponse = {
        cloudName: 'google-drive',
        apiKey: 'grind',
        uploadUrl: signed.uploadUrl,
        timestamp: signed.expires,
        signature: signed.signature,
        publicId: body.id,
        folder: env.GOOGLE_DRIVE_FOLDER_ID ?? 'google-drive',
        thumbTransform: '',
      };
      return res.json(response);
    }

    return res.status(503).json({ error: 'screenshot_storage_not_configured' });
  } catch (err) {
    next(err);
  }
});

screenshotsRouter.post('/complete', validate(CompleteScreenshotUploadRequest, 'body'), async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const userId = req.user.sub;
    const body = req.body as CompleteScreenshotUploadRequest;
    const existing = await prisma.screenshot.findUnique({
      where: { id: body.id },
      select: { userId: true, s3Key: true, thumbS3Key: true, fullUrl: true, thumbUrl: true },
    });
    if (existing && existing.userId !== userId) {
      return res.status(409).json({ error: 'screenshot_id_conflict' });
    }

    // A shot whose entry the server does not have yet — its create still in
    // the agent's sync queue — is kept detached and remembers the entry, which
    // links it when the entry arrives. Refusing it made installed agents count
    // five failures and write the shot off while its file sat in Drive. Only
    // somebody else's entry is out of scope.
    const claim = body.timeEntryId
      ? (await classifyEntryClaims(userId, [body.timeEntryId])).get(body.timeEntryId)!
      : null;
    if (claim?.kind === 'foreign') {
      logger.warn({ userId, screenshotId: body.id }, 'screenshot names another user\'s time entry');
      return res.status(400).json({ error: 'time_entry_out_of_scope' });
    }
    if (claim?.kind === 'claimed') {
      logger.info(
        { userId, screenshotId: body.id, claimedTimeEntryId: claim.claimedTimeEntryId },
        'screenshot stored ahead of its time entry',
      );
    }

    let storage: StoredScreenshotLocation;
    try {
      storage = await resolveStoredLocation(userId, body, existing);
    } catch (err) {
      if (!isDriveFailure(err)) throw err;
      logger.error({ err, screenshotId: body.id }, 'screenshot storage unavailable');
      return res.status(503).json({ error: 'screenshot_storage_unavailable' });
    }
    // The bytes are with us: whatever the agent concluded, the shot exists.
    const uploadState = storage.recorded ? 'UPLOADED' : body.uploadState;
    if (uploadState === 'UPLOADED' && !storage.location.s3Key && !storage.location.fullUrl) {
      return res.status(422).json({ error: 'screenshot_upload_not_found' });
    }
    const phash = body.phash !== undefined && body.phash !== null ? BigInt(body.phash) : null;
    const metadata = {
      userId,
      timeEntryId: claim?.kind === 'owned' ? claim.timeEntryId : null,
      claimedTimeEntryId: claim?.kind === 'claimed' ? claim.claimedTimeEntryId : null,
      displayId: body.displayId ?? null,
      capturedAt: new Date(body.capturedAt),
      bytes: body.bytes ?? null,
      width: body.width ?? null,
      height: body.height ?? null,
      phash,
      blurred: body.blurred ?? false,
      uploadState,
    };

    const row = await prisma.screenshot.upsert({
      where: { id: body.id },
      create: { id: body.id, ...metadata, ...storage.location },
      update: { ...metadata, ...storage.location },
      select: { id: true, uploadState: true },
    });
    if (claim?.kind === 'claimed') await linkClaimsIfEntriesArrived(userId, [claim.claimedTimeEntryId]);

    const response: CompleteScreenshotUploadResponse = {
      id: row.id,
      uploadState: row.uploadState,
    };
    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
});

interface StoredScreenshotLocation {
  /** True when the server itself recorded (or verified) where the bytes are. */
  recorded: boolean;
  location: {
    s3Key: string | null;
    thumbS3Key: string | null;
    fullUrl: string | null;
    thumbUrl: string | null;
  };
}

/**
 * Where a completed shot's bytes live — decided by the server, not the client.
 *
 * The agent's /complete body carries a file id and URLs, but those are only a
 * claim. Trusting them let a member point their own row at somebody else's
 * Drive file (and have the image endpoints serve it), or at any https URL for
 * the server to fetch. So:
 *   1. a location recorded by /direct-upload always wins;
 *   2. a Drive file id is accepted only if Drive names that file as this
 *      user's upload of this shot (an upload raced against a deploy);
 *   3. a Cloudinary location only within this account's own namespace;
 *   4. anything else is dropped.
 */
async function resolveStoredLocation(
  userId: string,
  body: CompleteScreenshotUploadRequest,
  existing: { s3Key: string | null; thumbS3Key: string | null; fullUrl: string | null; thumbUrl: string | null } | null,
): Promise<StoredScreenshotLocation> {
  const none = { s3Key: null, thumbS3Key: null, fullUrl: null, thumbUrl: null };
  if (existing?.s3Key) {
    return {
      recorded: true,
      location: {
        s3Key: existing.s3Key,
        thumbS3Key: existing.thumbS3Key,
        fullUrl: existing.fullUrl,
        thumbUrl: existing.thumbUrl,
      },
    };
  }
  if (body.uploadState !== 'UPLOADED') return { recorded: false, location: none };

  if (isGoogleDriveConfigured()) {
    if (body.s3Key && (await driveFileBelongsTo(body.s3Key, userId, body.id))) {
      return {
        recorded: true,
        location: { s3Key: body.s3Key, thumbS3Key: null, fullUrl: screenshotAssetUrl(body.s3Key), thumbUrl: null },
      };
    }
    return { recorded: false, location: none };
  }

  if (isCloudinaryConfigured()) {
    const expectedPublicId = `${env.CLOUDINARY_FOLDER}/${userId}/${body.id}`;
    const fullUrl = body.fullUrl && isOwnCloudinaryUrl(body.fullUrl, expectedPublicId) ? body.fullUrl : null;
    const thumbUrl = body.thumbUrl && isOwnCloudinaryUrl(body.thumbUrl, expectedPublicId) ? body.thumbUrl : null;
    return {
      recorded: false,
      location: {
        s3Key: body.s3Key === expectedPublicId ? body.s3Key : null,
        thumbS3Key: null,
        fullUrl,
        thumbUrl,
      },
    };
  }
  return { recorded: false, location: none };
}

/**
 * Record a Drive file as the bytes of (user, shot), once. Returns the file id
 * that ended up recorded — ours, or a concurrent upload's that got there first.
 */
async function recordDriveFile(input: {
  userId: string;
  screenshotId: string;
  fileId: string;
  capturedAt: Date;
}): Promise<string> {
  const fullUrl = screenshotAssetUrl(input.fileId);
  try {
    await prisma.screenshot.create({
      data: {
        id: input.screenshotId,
        userId: input.userId,
        capturedAt: input.capturedAt,
        s3Key: input.fileId,
        fullUrl,
        // Hidden until the agent's /complete brings the metadata.
        uploadState: 'PENDING',
      },
    });
    rememberVerifiedDriveFile(input.fileId, input.userId, input.screenshotId);
    return input.fileId;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  const { count } = await prisma.screenshot.updateMany({
    where: { id: input.screenshotId, userId: input.userId, s3Key: null },
    data: { s3Key: input.fileId, fullUrl },
  });
  if (count > 0) {
    rememberVerifiedDriveFile(input.fileId, input.userId, input.screenshotId);
    return input.fileId;
  }
  const row = await prisma.screenshot.findUnique({
    where: { id: input.screenshotId },
    select: { s3Key: true },
  });
  return row?.s3Key ?? input.fileId;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

function sendDriveUploadResult(res: Response, fileId: string) {
  const asset = screenshotAssetUrl(fileId);
  if (!asset) return res.status(503).json({ error: 'public_app_url_not_configured' });
  // Cloudinary-compatible shape for the existing agent uploader.
  return res.json({ secure_url: asset, public_id: fileId });
}

/** The business timezone a user's screenshots are filed in. */
async function userTimezone(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { workspaceId: true } });
  return user?.workspaceId ? await getWorkspaceTimezone(user.workspaceId) : 'UTC';
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Earliest instant a Timo screenshot id can plausibly carry. */
const EARLIEST_SCREENSHOT_MS = Date.UTC(2024, 0, 1);
const FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

/**
 * When a screenshot was taken, read from its id.
 *
 * Agents name shots with ULIDs, whose first ten characters are the capture
 * time in milliseconds. The upload arrives before /complete has told us the
 * capture time, and a backlog drained days later must still land in the month
 * it was TAKEN in — not the month it happened to be uploaded. Returns null for
 * anything that is not a plausible ULID, so the caller can fall back.
 */
export function capturedAtFromScreenshotId(id: string, now = Date.now()): Date | null {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/iu.test(id)) return null;
  let ms = 0;
  for (const ch of id.slice(0, 10).toUpperCase()) {
    ms = ms * 32 + CROCKFORD.indexOf(ch);
  }
  if (ms < EARLIEST_SCREENSHOT_MS || ms > now + FUTURE_SKEW_MS) return null;
  return new Date(ms);
}

async function canWriteScreenshot(userId: string, screenshotId: string): Promise<boolean> {
  const existing = await prisma.screenshot.findUnique({
    where: { id: screenshotId },
    select: { userId: true },
  });
  return !existing || existing.userId === userId;
}

type ScreenshotImageVariant = 'full' | 'thumb';

interface ScreenshotImageRow {
  id: string;
  userId: string;
  s3Key: string | null;
  fullUrl: string | null;
  thumbUrl: string | null;
}

function screenshotImageVariant(raw: unknown): ScreenshotImageVariant | null {
  return raw === 'full' || raw === 'thumb' ? raw : null;
}

/** Drive file ids proven to hold (userId, shotId)'s upload. Bounded; FIFO-evicted. */
const VERIFIED_DRIVE_FILES_MAX = 5_000;
const verifiedDriveFiles = new Map<string, string>();

function rememberVerifiedDriveFile(fileId: string, userId: string, screenshotId: string): void {
  if (verifiedDriveFiles.size >= VERIFIED_DRIVE_FILES_MAX) {
    const oldest = verifiedDriveFiles.keys().next().value;
    if (oldest !== undefined) verifiedDriveFiles.delete(oldest);
  }
  verifiedDriveFiles.set(fileId, screenshotDriveFileName(userId, screenshotId));
}

/**
 * Is this Drive file really (userId, shotId)'s upload?
 *
 * Rows written before the server recorded file ids itself carry whatever id
 * the client claimed. The name Drive holds was set by our upload endpoint from
 * a signed token, so it settles the question for old and new rows alike.
 * Throws a `google_drive_*` error when Drive cannot be asked.
 */
async function driveFileBelongsTo(fileId: string, userId: string, screenshotId: string): Promise<boolean> {
  const expected = screenshotDriveFileName(userId, screenshotId);
  if (verifiedDriveFiles.get(fileId) === expected) return true;
  const name = await getDriveFileName(fileId);
  if (name !== expected) return false;
  rememberVerifiedDriveFile(fileId, userId, screenshotId);
  return true;
}

async function loadScreenshotImage(row: ScreenshotImageRow, variant: ScreenshotImageVariant): Promise<Buffer | null> {
  // Drive keeps one size; the dashboard scales the thumbnail itself.
  if (isGoogleDriveConfigured() && row.s3Key) {
    try {
      if (await driveFileBelongsTo(row.s3Key, row.userId, row.id)) {
        return await downloadScreenshotFromDrive(row.s3Key);
      }
    } catch (err) {
      logger.warn({ err, screenshotId: row.id }, 'screenshot image unavailable from Drive');
    }
  }

  // Legacy Cloudinary rows only — never an arbitrary URL a client stored.
  const remoteUrl = variant === 'thumb' ? row.thumbUrl ?? row.fullUrl : row.fullUrl;
  if (!remoteUrl || !isOwnCloudinaryUrl(remoteUrl)) return null;
  return fetchRemoteScreenshot(remoteUrl);
}

/**
 * A URL on this deployment's own Cloudinary account (and, when given, for the
 * expected public id). Anything else — another host, another account — is not
 * somewhere the server will fetch from on a client's say-so.
 */
function isOwnCloudinaryUrl(rawUrl: string, publicId?: string): boolean {
  const cloudName = env.CLOUDINARY_CLOUD_NAME;
  if (!cloudName) return false;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'res.cloudinary.com' || url.port !== '') return false;
  if (!url.pathname.startsWith(`/${cloudName}/image/upload/`)) return false;
  return publicId ? url.pathname.includes(`/${publicId}`) : true;
}

async function fetchRemoteScreenshot(rawUrl: string): Promise<Buffer | null> {
  try {
    const response = await fetch(rawUrl, {
      redirect: 'error',
      signal: AbortSignal.timeout(REMOTE_IMAGE_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return null;
  }
}

function signDriveUpload(userId: string, id: string): { uploadUrl: string; expires: number; signature: string } {
  const base = publicAppUrl();
  if (!base) throw new Error('PUBLIC_APP_URL is required for Google Drive screenshot uploads');
  const expires = Math.floor(Date.now() / 1000) + DRIVE_UPLOAD_TTL_SECONDS;
  const signature = driveUploadSignature(userId, id, expires);
  const url = new URL('/v1/screenshots/direct-upload', base);
  url.searchParams.set('userId', userId);
  url.searchParams.set('id', id);
  url.searchParams.set('expires', String(expires));
  url.searchParams.set('sig', signature);
  return { uploadUrl: url.toString(), expires, signature };
}

function verifyDriveUploadToken(
  query: Record<string, unknown>,
):
  | { ok: true; userId: string; id: string }
  | { ok: false; status: 400 | 403 | 503; error: string } {
  const userId = typeof query.userId === 'string' ? query.userId : '';
  const id = typeof query.id === 'string' ? query.id : '';
  const expires = typeof query.expires === 'string' ? Number(query.expires) : NaN;
  const sig = typeof query.sig === 'string' ? query.sig : '';
  if (!userId || !id || !Number.isFinite(expires) || !sig) {
    return { ok: false, status: 400, error: 'invalid_upload_token' };
  }
  if (Math.floor(Date.now() / 1000) > expires) {
    return { ok: false, status: 403, error: 'upload_token_expired' };
  }
  const expected = driveUploadSignature(userId, id, expires);
  if (!safeEqual(sig, expected)) {
    return { ok: false, status: 403, error: 'invalid_upload_signature' };
  }
  return { ok: true, userId, id };
}

function driveUploadSignature(userId: string, id: string, expires: number): string {
  return crypto
    .createHmac('sha256', env.JWT_SECRET)
    .update(`${userId}:${id}:${expires}`)
    .digest('hex');
}

function screenshotAssetUrl(fileId: string): string | null {
  const base = publicAppUrl();
  if (!base) return null;
  return new URL(`/v1/screenshots/assets/${encodeURIComponent(fileId)}`, base).toString();
}

function publicAppUrl(): string | null {
  const raw = env.PUBLIC_APP_URL ?? dashboardOrigins()[0];
  return raw ? raw.replace(/\/$/u, '') : null;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.byteLength === bb.byteLength && crypto.timingSafeEqual(ab, bb);
}

function readRequestBody(req: Request, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        reject(new Error('screenshot_upload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function extractMultipartFile(body: Buffer, contentType: string): Buffer | null {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/iu.exec(contentType);
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) return null;

  const marker = Buffer.from(`--${boundary}`);
  let pos = body.indexOf(marker);
  while (pos !== -1) {
    pos += marker.byteLength;
    if (body.subarray(pos, pos + 2).toString() === '--') return null;
    if (body.subarray(pos, pos + 2).toString() === '\r\n') pos += 2;

    const headersEnd = body.indexOf(Buffer.from('\r\n\r\n'), pos);
    if (headersEnd === -1) return null;
    const headers = body.subarray(pos, headersEnd).toString('utf8');
    const contentStart = headersEnd + 4;
    const nextBoundary = body.indexOf(Buffer.from(`\r\n--${boundary}`), contentStart);
    if (nextBoundary === -1) return null;
    if (/content-disposition:[^\r\n]*\bname="file"/iu.test(headers)) {
      return body.subarray(contentStart, nextBoundary);
    }
    pos = body.indexOf(marker, nextBoundary + 2);
  }
  return null;
}
