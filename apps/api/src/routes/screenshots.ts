import { Router } from 'express';
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

export const screenshotsRouter = Router();
screenshotsRouter.use(requireAccessToken);

/**
 * Mint a short-lived Cloudinary signature so the agent can upload a screenshot
 * directly to Cloudinary. The api_secret never leaves the server. Returns 503
 * when Cloudinary isn't configured so the agent can keep shots local and retry.
 */
screenshotsRouter.post('/sign', validate(SignScreenshotUploadRequest, 'body'), async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    if (!isCloudinaryConfigured()) {
      return res.status(503).json({ error: 'cloudinary_not_configured' });
    }
    const body = req.body as SignScreenshotUploadRequest;
    if (!(await canWriteScreenshot(req.user.sub, body.id))) {
      return res.status(409).json({ error: 'screenshot_id_conflict' });
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

export default screenshotsRouter;
