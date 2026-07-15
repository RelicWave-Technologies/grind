import {
  ACTIVITY_METADATA_MAX_CHARS,
  type ActivitySampleInput,
  type ActivitySamplesResponse,
} from '@grind/types';
import { api } from '../apiClient';
import { log } from '../../logger';
import type { ActivityStore, ActivityRow } from './store';

// A batch must stay comfortably under the API's body-size limit. If it doesn't,
// the POST is rejected with 413 and — because a count-based batch never shrinks
// on its own — that user's activity would never sync again (it snowballs). So we
// bound the batch by BYTES, not just row count, and cap the per-sample text
// fields, so neither a run of long active-URLs nor one giant sample can blow
// past the limit.
const MAX_BATCH_ROWS = 500; // also the server-side schema cap (ActivitySamplesRequest)
const MAX_BATCH_BYTES = 48 * 1024; // headroom under the API's activity-route limit
function cap(s: string | null, maxChars: number): string | null {
  return s != null && s.length > maxChars ? s.slice(0, maxChars) : s;
}

function toInput(r: ActivityRow): ActivitySampleInput {
  return {
    id: r.id,
    timeEntryId: r.timeEntryId,
    bucketStart: new Date(r.bucketStart).toISOString(),
    keystrokes: r.keystrokes,
    clicks: r.clicks,
    mouseDistancePx: r.mouseDistancePx,
    scrollEvents: r.scrollEvents,
    ikiCv: r.ikiCv,
    moveSpeedCv: r.moveSpeedCv,
    pathStraightness: r.pathStraightness,
    activeApp: cap(r.activeApp, ACTIVITY_METADATA_MAX_CHARS.activeApp),
    activeAppBundle: cap(r.activeAppBundle, ACTIVITY_METADATA_MAX_CHARS.activeAppBundle),
    activeTitle: cap(r.activeTitle, ACTIVITY_METADATA_MAX_CHARS.activeTitle),
    activeUrl: cap(r.activeUrl, ACTIVITY_METADATA_MAX_CHARS.activeUrl),
  };
}

/**
 * Push unsynced activity samples to the API in a byte-bounded batch. Returns the
 * number of rows synced (0 when nothing is pending). The remaining backlog
 * drains on subsequent calls (the sync drain loops), so a large backlog clears
 * in safe chunks instead of one oversized — and rejected — request.
 */
export async function flushActivity(
  store: ActivityStore,
  isTimeEntryPendingCreate: (entryId: string) => boolean = () => false,
): Promise<number> {
  const rows = store
    .unsynced(MAX_BATCH_ROWS)
    .filter((row) => row.timeEntryId === null || !isTimeEntryPendingCreate(row.timeEntryId));
  if (rows.length === 0) return 0;

  // Pack the longest prefix whose JSON stays under the byte budget — always at
  // least one row, so a single large sample still makes forward progress.
  const batch: { id: string; input: ActivitySampleInput }[] = [];
  let bytes = 20; // {"samples":[ ... ]} envelope
  for (const r of rows) {
    const input = toInput(r);
    const size = Buffer.byteLength(JSON.stringify(input), 'utf8') + 1; // + comma
    if (batch.length > 0 && bytes + size > MAX_BATCH_BYTES) break;
    batch.push({ id: r.id, input });
    bytes += size;
  }

  try {
    const response = await api<ActivitySamplesResponse>('/v1/activity-samples', {
      method: 'POST',
      body: { samples: batch.map((b) => b.input) },
    });
    store.markSynced(batch.map((b) => b.id));
    if ((response?.detached ?? 0) > 0) {
      log.warn('activity samples accepted without unavailable timer parent', { count: response.detached });
    }
    log.debug('flushed activity samples', { count: batch.length, bytes });
    return batch.length;
  } catch (err) {
    log.warn('activity flush failed', { err: String(err) });
    throw err;
  }
}
