import { z } from 'zod';

const Iso = z.string().datetime({ offset: true });

/**
 * Wire-contract limits for optional foreground-window metadata. The desktop
 * agent imports these values before upload so one malformed long value cannot
 * make a whole durable activity batch permanently retry.
 */
export const ACTIVITY_METADATA_MAX_CHARS = {
  activeApp: 120,
  activeAppBundle: 200,
  activeTitle: 300,
  activeUrl: 2048,
} as const;

export const ActivitySampleInput = z.object({
  id: z.string().min(1),
  timeEntryId: z.string().min(1).nullable().optional(),
  bucketStart: Iso,
  keystrokes: z.number().int().min(0),
  clicks: z.number().int().min(0),
  mouseDistancePx: z.number().int().min(0),
  scrollEvents: z.number().int().min(0),
  ikiCv: z.number().nullable().optional(),
  moveSpeedCv: z.number().nullable().optional(),
  pathStraightness: z.number().nullable().optional(),
  // M14: dominant active app + window in the bucket. Title/URL are
  // policy-gated client-side AND server-side strips them when the
  // workspace policy disallows them — so even a misbehaving agent
  // can't sneak titles/URLs in.
  activeApp: z.string().max(ACTIVITY_METADATA_MAX_CHARS.activeApp).nullable().optional(),
  activeAppBundle: z.string().max(ACTIVITY_METADATA_MAX_CHARS.activeAppBundle).nullable().optional(),
  activeTitle: z.string().max(ACTIVITY_METADATA_MAX_CHARS.activeTitle).nullable().optional(),
  activeUrl: z.string().max(ACTIVITY_METADATA_MAX_CHARS.activeUrl).nullable().optional(),
});
export type ActivitySampleInput = z.infer<typeof ActivitySampleInput>;

/** Batch upload (the agent flushes ~1 sample/min and uploads in small batches). */
export const ActivitySamplesRequest = z.object({
  samples: z.array(ActivitySampleInput).min(1).max(500),
});
export type ActivitySamplesRequest = z.infer<typeof ActivitySamplesRequest>;

export const ActivitySamplesResponse = z.object({
  accepted: z.number().int(),
  /** Samples retained safely without a missing or foreign timer parent. */
  detached: z.number().int().min(0).optional(),
});
export type ActivitySamplesResponse = z.infer<typeof ActivitySamplesResponse>;
