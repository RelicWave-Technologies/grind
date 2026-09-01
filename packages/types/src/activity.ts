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

/**
 * An unpaired UTF-16 surrogate — half of an astral character such as an emoji.
 *
 * Deliberately NOT a `u`-flag regex: unicode mode matches code points, and a
 * lone surrogate is precisely the thing that is not one. Matching code units
 * is the point here.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Drop any half-character left behind by truncation.
 *
 * `String.prototype.slice` cuts on code units, so capping a window title at
 * 300 can land inside an emoji and leave a lone surrogate. That is a valid JS
 * string and `JSON.stringify` emits it happily as `"\ud83d"`, but it cannot be
 * encoded as UTF-8: Postgres's driver rejects the statement with "unexpected
 * end of hex escape" and the ENTIRE batch of samples is lost, not just the one
 * bad title.
 *
 * Applied here rather than only in the agent because every agent in the field
 * has to be updated one machine at a time, and the server can defend itself
 * today. Intact emoji are untouched.
 */
export function stripLoneSurrogates(value: string): string {
  return value.replace(LONE_SURROGATE, '');
}

/** A metadata string that is length-capped and safe to store. */
function metadataString(maxChars: number) {
  return z.string().max(maxChars).transform(stripLoneSurrogates);
}

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
  activeApp: metadataString(ACTIVITY_METADATA_MAX_CHARS.activeApp).nullable().optional(),
  activeAppBundle: metadataString(ACTIVITY_METADATA_MAX_CHARS.activeAppBundle).nullable().optional(),
  activeTitle: metadataString(ACTIVITY_METADATA_MAX_CHARS.activeTitle).nullable().optional(),
  activeUrl: metadataString(ACTIVITY_METADATA_MAX_CHARS.activeUrl).nullable().optional(),
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
