import type { ActivitySampleInput } from '@grind/types';
import { api } from '../apiClient';
import { log } from '../../logger';
import type { ActivityStore, ActivityRow } from './store';

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
  };
}

/** Push unsynced activity samples to the API in a batch (best-effort). */
export async function flushActivity(store: ActivityStore): Promise<void> {
  const rows = store.unsynced(200);
  if (rows.length === 0) return;
  try {
    await api('/v1/activity-samples', { method: 'POST', body: { samples: rows.map(toInput) } });
    store.markSynced(rows.map((r) => r.id));
    log.debug('flushed activity samples', { count: rows.length });
  } catch (err) {
    log.warn('activity flush failed', { err: String(err) });
  }
}
