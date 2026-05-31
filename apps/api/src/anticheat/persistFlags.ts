import { prisma } from '@grind/db';
import { assessWindow, type RiskSample } from './risk';

/**
 * Run the risk engine over a freshly-uploaded batch of activity samples and
 * upsert any flags into ActivityFlag. Pure-DB writes: the risk engine itself
 * is already covered by exhaustive unit tests; this layer is just bookkeeping.
 *
 * Invariants:
 *   - Flag rows are deduped via the (userId, windowStart, type) unique index
 *     so re-uploads (or duplicate batches) never multiply flags.
 *   - The window is [min(bucketStart), max(bucketStart) + 1 min) — wide enough
 *     that two adjacent batches with the same pattern produce one flag, not
 *     two stuttering ones.
 *   - We never mutate existing RESOLVED rows. If a flag has already been
 *     dismissed/confirmed by a reviewer, a fresh upload of the same pattern
 *     stays resolved — the engine's signal hasn't changed; the human verdict
 *     stands.
 *   - Failure here MUST NOT block the activity upload — the route awaits the
 *     primary upsert; this helper runs after the response is committed.
 */
export interface PersistFlagsInput {
  userId: string;
  /** Already-persisted samples; in epoch-ms `bucketStart`. */
  samples: Array<{
    bucketStartMs: number;
    keystrokes: number;
    clicks: number;
    scrollEvents: number;
    mouseDistancePx: number;
    ikiCv: number | null;
    moveSpeedCv: number | null;
    pathStraightness: number | null;
  }>;
}

export interface PersistFlagsResult {
  /** Flags raised by this assessment (may be fewer than rows written if upserts skipped resolved). */
  raised: number;
  /** Newly-inserted Flag rows (excludes resolved-hit no-ops). */
  inserted: number;
  riskScore: number;
}

const MIN_MS = 60_000;

export async function persistFlagsForUser(input: PersistFlagsInput): Promise<PersistFlagsResult> {
  if (input.samples.length === 0) return { raised: 0, inserted: 0, riskScore: 0 };
  const riskInput: RiskSample[] = input.samples.map((s) => ({
    keystrokes: s.keystrokes,
    clicks: s.clicks,
    scrollEvents: s.scrollEvents,
    mouseDistancePx: s.mouseDistancePx,
    ikiCv: s.ikiCv,
    moveSpeedCv: s.moveSpeedCv,
    pathStraightness: s.pathStraightness,
  }));
  const assessment = assessWindow(riskInput);
  if (assessment.flags.length === 0) {
    return { raised: 0, inserted: 0, riskScore: 0 };
  }

  const startMs = Math.min(...input.samples.map((s) => s.bucketStartMs));
  const endMs = Math.max(...input.samples.map((s) => s.bucketStartMs)) + MIN_MS;
  const windowStart = new Date(startMs);
  const windowEnd = new Date(endMs);

  let inserted = 0;
  for (const f of assessment.flags) {
    // Skip if a RESOLVED row already exists — preserve the human verdict.
    const existing = await prisma.activityFlag.findUnique({
      where: { userId_windowStart_type: { userId: input.userId, windowStart, type: f.type } },
    });
    if (existing?.status === 'RESOLVED') continue;
    await prisma.activityFlag.upsert({
      where: { userId_windowStart_type: { userId: input.userId, windowStart, type: f.type } },
      create: {
        userId: input.userId,
        type: f.type,
        windowStart,
        windowEnd,
        riskScore: f.riskScore,
        evidence: f.evidence,
      },
      update: {
        windowEnd, // pattern may have extended; capture the new far edge
        riskScore: f.riskScore,
        evidence: f.evidence,
      },
    });
    if (!existing) inserted += 1;
  }
  return { raised: assessment.flags.length, inserted, riskScore: assessment.riskScore };
}
