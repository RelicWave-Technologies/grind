import { Router } from 'express';
import { prisma } from '@grind/db';
import {
  ActivitySamplesRequest,
  type ActivitySamplesResponse,
  applyPolicyToActive,
  WORKSPACE_POLICY_DEFAULTS,
} from '@grind/types';
import { validate } from '../middleware/validate';
import { requireAccessToken } from '../middleware/auth';
import { persistFlagsForUser } from '../anticheat/persistFlags';
import { logger } from '../logger';

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

    // Resolve the caller's workspace policy ONCE per request — defaults
    // when none exists. We pass the flags through `applyPolicyToActive`
    // for every sample so a misbehaving / outdated agent can never
    // smuggle in disabled active-window fields.
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { workspaceId: true },
    });
    const policyRow = user
      ? await prisma.workspacePolicy.findUnique({ where: { workspaceId: user.workspaceId } })
      : null;
    const policy = policyRow ?? WORKSPACE_POLICY_DEFAULTS;

    await prisma.$transaction(
      samples.map((s) => {
        const scrubbed = applyPolicyToActive(
          {
            activeApp: s.activeApp ?? null,
            activeAppBundle: s.activeAppBundle ?? null,
            activeTitle: s.activeTitle ?? null,
            activeUrl: s.activeUrl ?? null,
          },
          policy,
        );
        return prisma.activitySample.upsert({
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
            activeApp: scrubbed.activeApp,
            activeAppBundle: scrubbed.activeAppBundle,
            activeTitle: scrubbed.activeTitle,
            activeUrl: scrubbed.activeUrl,
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
            activeApp: scrubbed.activeApp,
            activeAppBundle: scrubbed.activeAppBundle,
            activeTitle: scrubbed.activeTitle,
            activeUrl: scrubbed.activeUrl,
          },
        });
      }),
    );

    const response: ActivitySamplesResponse = { accepted: samples.length };
    res.status(201).json(response);

    // Anti-cheat scoring runs AFTER the response — it's a side effect for
    // the manager's review queue, never on the agent's hot path. Failure
    // here gets logged but doesn't bubble up: a flag-write hiccup must not
    // make the agent think its samples were rejected.
    void (async () => {
      try {
        const result = await persistFlagsForUser({
          userId,
          samples: samples.map((s) => ({
            bucketStartMs: new Date(s.bucketStart).getTime(),
            keystrokes: s.keystrokes,
            clicks: s.clicks,
            scrollEvents: s.scrollEvents,
            mouseDistancePx: s.mouseDistancePx,
            ikiCv: s.ikiCv ?? null,
            moveSpeedCv: s.moveSpeedCv ?? null,
            pathStraightness: s.pathStraightness ?? null,
          })),
        });
        if (result.inserted > 0) {
          logger.info({ userId, flagsInserted: result.inserted, riskScore: result.riskScore }, 'anti-cheat flags raised');
        }
      } catch (err) {
        logger.warn({ err: String(err), userId }, 'persistFlagsForUser failed (non-fatal)');
      }
    })();
  } catch (err) {
    next(err);
  }
});
