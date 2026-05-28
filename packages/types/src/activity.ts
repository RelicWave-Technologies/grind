import { z } from 'zod';

const Iso = z.string().datetime({ offset: true });

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
});
export type ActivitySampleInput = z.infer<typeof ActivitySampleInput>;

/** Batch upload (the agent flushes ~1 sample/min and uploads in small batches). */
export const ActivitySamplesRequest = z.object({
  samples: z.array(ActivitySampleInput).min(1).max(500),
});
export type ActivitySamplesRequest = z.infer<typeof ActivitySamplesRequest>;

export const ActivitySamplesResponse = z.object({
  accepted: z.number().int(),
});
export type ActivitySamplesResponse = z.infer<typeof ActivitySamplesResponse>;
