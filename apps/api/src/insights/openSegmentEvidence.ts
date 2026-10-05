/**
 * Moved to `@grind/core` (`time/evidence.ts`). Kept as a thin re-export only
 * for payroll, which is being removed; new code imports from `@grind/core`.
 */
export {
  OPEN_SEGMENT_FRESH_MS,
  effectiveSegmentEnd as resolveEffectiveSegmentEnd,
  effectiveEntrySegmentEnds as resolveEffectiveEntrySegmentEnds,
  type TimerLifecycleEvidence,
} from '@grind/core';
