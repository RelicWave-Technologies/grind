import { Router } from 'express';
import { prisma } from '@grind/db';
import { ActivitySamplesRequest, type ActivitySamplesResponse } from '@grind/types';
import { validate } from '../middleware/validate';
import { requireAccessToken } from '../middleware/auth';

export const activityRouter = Router();

activityRouter.use(requireAccessToken);

/**
 * Batch-ingest per-minute activity samples. Idempotent on (userId, bucketStart):
 * re-uploading the same minute updates in place, so agent retries never
 * duplicate. Samples are content-free counts + timing CVs.
 */
activityRouter.post('/', validate(ActivitySamplesRequest, 'body'), async (req, res, next) => {
  try {
    if (!req.user) return res.status(401).json({ error: 'unauthorized' });
    const { samples } = req.body as ActivitySamplesRequest;
    const userId = req.user.sub;

    await prisma.$transaction(
      samples.map((s) =>
        prisma.activitySample.upsert({
          where: { userId_bucketStart: { userId, bucketStart: new Date(s.bucketStart) } },
          create: {
            id: s.id,
            userId,
            timeEntryId: s.timeEntryId ?? null,
            bucketStart: new Date(s.bucketStart),
            keystrokes: s.keystrokes,
            clicks: s.clicks,
            mouseDistancePx: s.mouseDistancePx,
            scrollEvents: s.scrollEvents,
            ikiCv: s.ikiCv ?? null,
            moveSpeedCv: s.moveSpeedCv ?? null,
            pathStraightness: s.pathStraightness ?? null,
          },
          update: {
            timeEntryId: s.timeEntryId ?? null,
            keystrokes: s.keystrokes,
            clicks: s.clicks,
            mouseDistancePx: s.mouseDistancePx,
            scrollEvents: s.scrollEvents,
            ikiCv: s.ikiCv ?? null,
            moveSpeedCv: s.moveSpeedCv ?? null,
            pathStraightness: s.pathStraightness ?? null,
          },
        }),
      ),
    );

    const response: ActivitySamplesResponse = { accepted: samples.length };
    res.status(201).json(response);
  } catch (err) {
    next(err);
  }
});
