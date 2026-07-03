import crypto from 'node:crypto';
import { Router, type Request } from 'express';
import { prisma } from '@grind/db';
import {
  CompleteScreenshotUploadRequest,
  CompleteScreenshotUploadResponse,
  PendingScreenshotUploadRequest,
  PendingScreenshotUploadResponse,
  SignScreenshotUploadRequest,
  SignScreenshotUploadResponse,
} from '@grind/types';
import { requireAccessToken } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { isCloudinaryConfigured, signScreenshotUpload } from '../lib/cloudinary';
import {
  downloadScreenshotFromDrive,
  isGoogleDriveConfigured,
  uploadScreenshotToDrive,
} from '../lib/googleDrive';
import { env } from '../env';
import { attachScope } from '../middleware/scope';

export const screenshotsRouter = Router();

const MAX_SCREENSHOT_UPLOAD_BYTES = 8 * 1024 * 1024;
const DRIVE_UPLOAD_TTL_SECONDS = 10 * 60;

screenshotsRouter.post('/direct-upload', async (req, res, next) => {
  try {
    if (!isGoogleDriveConfigured()) return res.status(503).json({ error: 'google_drive_not_configured' });
    const token = verifyDriveUploadToken(req.query as Record<string, unknown>);
    if (!token.ok) return res.status(token.status).json({ error: token.error });
    if (!(await canWriteScreenshot(token.userId, token.id))) {
      return res.status(409).json({ error: 'screenshot_id_conflict' });
    }

    const raw = await readRequestBody(req, MAX_SCREENSHOT_UPLOAD_BYTES);
    const file = extractMultipartFile(raw, String(req.headers['content-type'] ?? ''));
    if (!file || file.byteLength === 0) return res.status(400).json({ error: 'missing_file' });

    const uploaded = await uploadScreenshotToDrive({
      data: file,
      filename: `${token.userId}-${token.id}.webp`,
    });
    const asset = screenshotAssetUrl(uploaded.fileId);
    if (!asset) return res.status(503).json({ error: 'public_app_url_not_configured' });

    // Cloudinary-compatible shape for the existing agent uploader.
    res.json({ secure_url: asset, public_id: uploaded.fileId });
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
        userId: true,
        uploadState: true,
        deletedAt: true,
        s3Key: true,
        thumbS3Key: true,
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
    const row = await prisma.screenshot.findFirst({
      where: {
        OR: [{ s3Key: fileId }, { thumbS3Key: fileId }],
        deletedAt: null,
        uploadState: 'UPLOADED',
      },
      select: { userId: true },
    });
    if (!row) return res.status(404).json({ error: 'screenshot_not_found' });
    if (!req.scope.userIds.includes(row.userId)) return res.status(403).json({ error: 'forbidden' });

    const data = await downloadScreenshotFromDrive(fileId);
    res.setHeader('Content-Type', 'image/webp');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(data);
  } catch (err) {
    next(err);
  }
});

/**
 * Mint a short-lived upload target. Google Drive is preferred when configured,
 * but the response intentionally keeps the Cloudinary-shaped contract so
 * already-installed agents can upload without a desktop rebuild.
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

    if (!isCloudinaryConfigured()) {
      return res.status(503).json({ error: 'screenshot_storage_not_configured' });
    }

    // Namespace the public_id under the user so re-uploads overwrite in place
    // and shots from different users never collide.
    const signed = signScreenshotUpload(`${req.user.sub}/${body.id}`);
    const response: SignScreenshotUploadResponse = {
      cloudName: signed.cloudName,
      apiKey: signed.apiKey,
      uploadUrl: signed.uploadUrl,
      timestamp: signed.timestamp,
      signature: signed.signature,
      publicId: signed.publicId,
      folder: signed.folder,
      thumbTransform: signed.thumbTransform,
    };
    res.json(response);
  } catch (err) {
    next(err);
  }
});

screenshotsRouter.post('/pending', validate(PendingScreenshotUploadRequest, 'body'), async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const body = req.body as PendingScreenshotUploadRequest;
    if (!(await canWriteScreenshot(req.user.sub, body.id))) {
      return res.status(409).json({ error: 'screenshot_id_conflict' });
    }
    const timeEntryId = await validateOwnedTimeEntry(req.user.sub, body.timeEntryId ?? null);
    if (timeEntryId === false) return res.status(400).json({ error: 'time_entry_out_of_scope' });

    const row = await prisma.screenshot.upsert({
      where: { id: body.id },
      create: {
        id: body.id,
        userId: req.user.sub,
        timeEntryId,
        displayId: body.displayId ?? null,
        capturedAt: new Date(body.capturedAt),
        bytes: body.bytes ?? null,
        width: body.width ?? null,
        height: body.height ?? null,
        blurred: body.blurred ?? false,
        uploadState: 'PENDING',
      },
      update: {
        userId: req.user.sub,
        timeEntryId,
        displayId: body.displayId ?? null,
        capturedAt: new Date(body.capturedAt),
        bytes: body.bytes ?? null,
        width: body.width ?? null,
        height: body.height ?? null,
        blurred: body.blurred ?? false,
        uploadState: 'PENDING',
      },
      select: { id: true },
    });

    const response: PendingScreenshotUploadResponse = {
      id: row.id,
      uploadState: 'PENDING',
      uploadUrl: null,
      uploadHeaders: {},
    };
    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
});

screenshotsRouter.post('/complete', validate(CompleteScreenshotUploadRequest, 'body'), async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const body = req.body as CompleteScreenshotUploadRequest;
    if (!(await canWriteScreenshot(req.user.sub, body.id))) {
      return res.status(409).json({ error: 'screenshot_id_conflict' });
    }
    const timeEntryId = await validateOwnedTimeEntry(req.user.sub, body.timeEntryId ?? null);
    if (timeEntryId === false) return res.status(400).json({ error: 'time_entry_out_of_scope' });
    const phash = body.phash !== undefined && body.phash !== null ? BigInt(body.phash) : null;

    const row = await prisma.screenshot.upsert({
      where: { id: body.id },
      create: {
        id: body.id,
        userId: req.user.sub,
        timeEntryId,
        displayId: body.displayId ?? null,
        capturedAt: new Date(body.capturedAt),
        s3Key: body.s3Key ?? null,
        thumbS3Key: body.thumbS3Key ?? null,
        fullUrl: body.fullUrl ?? null,
        thumbUrl: body.thumbUrl ?? null,
        bytes: body.bytes ?? null,
        width: body.width ?? null,
        height: body.height ?? null,
        phash,
        blurred: body.blurred ?? false,
        uploadState: body.uploadState,
      },
      update: {
        userId: req.user.sub,
        timeEntryId,
        displayId: body.displayId ?? null,
        capturedAt: new Date(body.capturedAt),
        s3Key: body.s3Key ?? null,
        thumbS3Key: body.thumbS3Key ?? null,
        fullUrl: body.fullUrl ?? null,
        thumbUrl: body.thumbUrl ?? null,
        bytes: body.bytes ?? null,
        width: body.width ?? null,
        height: body.height ?? null,
        phash,
        blurred: body.blurred ?? false,
        uploadState: body.uploadState,
      },
      select: { id: true, uploadState: true },
    });

    const response: CompleteScreenshotUploadResponse = {
      id: row.id,
      uploadState: row.uploadState,
    };
    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
});

async function validateOwnedTimeEntry(userId: string, timeEntryId: string | null): Promise<string | null | false> {
  if (!timeEntryId) return null;
  const row = await prisma.timeEntry.findUnique({
    where: { id: timeEntryId },
    select: { userId: true },
  });
  return row?.userId === userId ? timeEntryId : false;
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
  s3Key: string | null;
  thumbS3Key: string | null;
  fullUrl: string | null;
  thumbUrl: string | null;
}

function screenshotImageVariant(raw: unknown): ScreenshotImageVariant | null {
  return raw === 'full' || raw === 'thumb' ? raw : null;
}

async function loadScreenshotImage(row: ScreenshotImageRow, variant: ScreenshotImageVariant): Promise<Buffer | null> {
  const driveKey = variant === 'thumb' ? row.thumbS3Key ?? row.s3Key : row.s3Key;
  if (isGoogleDriveConfigured() && driveKey) {
    try {
      return await downloadScreenshotFromDrive(driveKey);
    } catch {
      // Legacy Cloudinary rows can still have s3Key-style public ids after
      // Drive is enabled. Fall through to the stored provider URL.
    }
  }

  const remoteUrl = variant === 'thumb' ? row.thumbUrl ?? row.fullUrl : row.fullUrl;
  if (!remoteUrl) return null;
  return fetchRemoteScreenshot(remoteUrl);
}

async function fetchRemoteScreenshot(rawUrl: string): Promise<Buffer | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;

  const response = await fetch(url);
  if (!response.ok) return null;
  const bytes = await response.arrayBuffer();
  return Buffer.from(bytes);
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
  const raw = env.PUBLIC_APP_URL ?? env.DASHBOARD_URL?.split(',')[0]?.trim();
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

export default screenshotsRouter;
