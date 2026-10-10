import {
  ACTIVITY_METADATA_MAX_CHARS,
  type ActivitySampleInput,
  type ActivitySamplesResponse,
} from '@grind/types';
import { api, HttpError } from '../apiClient';
import { log } from '../../logger';
import { serverAlignedNow } from '../serverClock';
import type { ActivityOwner, ActivityStore, ActivityRow } from './store';

// A batch must stay comfortably under the API's body-size limit. If it doesn't,
// the POST is rejected with 413 and — because a count-based batch never shrinks
// on its own — that user's activity would never sync again (it snowballs). So we
// bound the batch by BYTES, not just row count, and cap the per-sample text
// fields, so neither a run of long active-URLs nor one giant sample can blow
// past the limit.
const MAX_BATCH_ROWS = 500; // also the server-side schema cap (ActivitySamplesRequest)
const MAX_BATCH_BYTES = 48 * 1024; // headroom under the API's activity-route limit
/**
 * How long a sample waits for its timer entry to reach the server. Sent
 * together, the minute lands already linked; but an entry can stay unsent for
 * hours (offline, refused, parked) and its activity must not wait with it.
 * After this the sample goes with its timeEntryId anyway, and the server links
 * it when the entry arrives.
 */
export const MAX_ENTRY_HOLD_MS = 10 * 60_000;
/**
 * Cap a metadata string without leaving half a character behind.
 *
 * `slice` cuts on UTF-16 code units, so capping at 300 can land inside an
 * emoji and leave a lone high surrogate. That string cannot be encoded as
 * UTF-8, and the server's driver rejects the whole batch — every sample in it,
 * not just the one with the bad title. Dropping the orphaned half is enough;
 * the character was already being truncated away.
 */
function cap(s: string | null, maxChars: number): string | null {
  if (s == null || s.length <= maxChars) return s;
  const cut = s.slice(0, maxChars);
  const last = cut.charCodeAt(cut.length - 1);
  const isHighSurrogate = last >= 0xd800 && last <= 0xdbff;
  return isHighSurrogate ? cut.slice(0, -1) : cut;
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

export interface FlushActivityOptions {
  /** The signed-in account; only its samples are sent. None → nothing is sent. */
  owner: ActivityOwner | null;
  /**
   * Belt and braces over the store's own SQL filter: a recent sample whose
   * timer entry is still waiting to be created stays queued.
   */
  isTimeEntryPendingCreate?: (entryId: string) => boolean;
  /** Server-aligned now, the frame of `bucketStart`. */
  now?: number;
  /** Claim legacy unowned samples for `owner` (the caller runs it once per owner change). */
  claimUnowned?: (owner: ActivityOwner) => void;
  /**
   * Checked right before the request: the API sends whichever session is
   * current, so samples read for one account must not go up under another.
   */
  stillOwner?: () => Promise<boolean>;
}

type Outgoing = { id: string; rev: number | undefined; input: ActivitySampleInput };

/**
 * The API itself refused the request body (a 4xx other than auth, timeout or
 * throttling): something in the batch is bad, and resending it unchanged is
 * refused again forever.
 */
function isBatchRefusal(err: unknown): boolean {
  return err instanceof HttpError
    && err.status >= 400 && err.status < 500
    && ![401, 403, 408, 429].includes(err.status);
}

/**
 * Send a batch; on a refusal, split it and send the halves, down to the single
 * sample the API will not take, which is quarantined (and logged, once) so the
 * rest of the queue moves on. Returns how many rows were settled.
 */
async function sendOrSplit(store: ActivityStore, batch: Outgoing[]): Promise<number> {
  try {
    const response = await api<ActivitySamplesResponse>('/v1/activity-samples', {
      method: 'POST',
      body: { samples: batch.map((b) => b.input) },
    });
    // Only what is still the version we sent: a tail merged in meanwhile stays queued.
    store.markSynced(batch.map((b) => ({ id: b.id, rev: b.rev })));
    if ((response?.detached ?? 0) > 0) {
      log.warn('activity samples accepted without unavailable timer parent', { count: response.detached });
    }
    return batch.length;
  } catch (err) {
    if (!isBatchRefusal(err)) throw err;
    if (batch.length === 1) {
      const [bad] = batch as [Outgoing];
      store.quarantine(bad.id);
      log.warn('activity sample refused by the API; quarantined so the queue can move on', {
        id: bad.id,
        bucketStart: bad.input.bucketStart,
        err: String(err),
      });
      return 1;
    }
    const mid = Math.ceil(batch.length / 2);
    return (await sendOrSplit(store, batch.slice(0, mid))) + (await sendOrSplit(store, batch.slice(mid)));
  }
}

/**
 * Push unsynced activity samples to the API in a byte-bounded batch. Returns the
 * number of rows settled (0 when nothing is pending). The remaining backlog
 * drains on subsequent calls (the sync drain loops), so a large backlog clears
 * in safe chunks instead of one oversized — and rejected — request.
 */
export async function flushActivity(store: ActivityStore, options: FlushActivityOptions): Promise<number> {
  const { owner, isTimeEntryPendingCreate = () => false, now = serverAlignedNow() } = options;
  if (!owner) return 0;
  if (options.claimUnowned) options.claimUnowned(owner);
  else store.claimUnowned(owner);
  const holdFrom = now - MAX_ENTRY_HOLD_MS;
  const rows = store
    .unsynced(MAX_BATCH_ROWS, owner, holdFrom)
    .filter((row) => row.timeEntryId === null || row.bucketStart < holdFrom || !isTimeEntryPendingCreate(row.timeEntryId));
  if (rows.length === 0) return 0;

  // Pack the longest prefix whose JSON stays under the byte budget — always at
  // least one row, so a single large sample still makes forward progress.
  const batch: Outgoing[] = [];
  let bytes = 20; // {"samples":[ ... ]} envelope
  for (const r of rows) {
    const input = toInput(r);
    const size = Buffer.byteLength(JSON.stringify(input), 'utf8') + 1; // + comma
    if (batch.length > 0 && bytes + size > MAX_BATCH_BYTES) break;
    batch.push({ id: r.id, rev: r.rev, input });
    bytes += size;
  }

  if (options.stillOwner && !(await options.stillOwner())) {
    log.info('activity flush skipped: the signed-in account changed');
    return 0;
  }

  try {
    const settled = await sendOrSplit(store, batch);
    log.debug('flushed activity samples', { count: settled, bytes });
    return settled;
  } catch (err) {
    log.warn('activity flush failed', { err: String(err) });
    throw err;
  }
}
