import type { PolicyFlags } from '@grind/types';
import { ActivityStore, type ActivityRow } from '../../../legacy/agent/src/main/services/activity/store';
import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';
import { REAL_ROWS, T0, MIN, id } from './common';
import { runCase, lit, type StoreCase } from './storeDb';
import { bucket, count, maybeText, ratio } from './storeValues';
import { smallCount } from './seq';

const module = 'store';

type Op =
  | { op: 'insert'; row: ActivityRow }
  | { op: 'unsynced'; limit: number }
  | { op: 'markSynced'; ids: string[] }
  | { op: 'scrub'; policy: PolicyFlags }
  | { op: 'countSince'; sinceMs: number }
  | { op: 'aggregate'; fromMs: number; toMs: number }
  | { op: 'reopen' }
  | { op: 'exec'; sql: string };

type Input = StoreCase<Op>;

/** The table as the first release created it: none of the active-window columns. */
const LEGACY_DDL = `CREATE TABLE activity_samples (
  id TEXT PRIMARY KEY, time_entry_id TEXT, bucket_start INTEGER NOT NULL, keystrokes INTEGER NOT NULL,
  clicks INTEGER NOT NULL, mouse_dist_px INTEGER NOT NULL, scroll_events INTEGER NOT NULL,
  iki_cv REAL, move_speed_cv REAL, path_straight REAL, synced INTEGER NOT NULL DEFAULT 0
)`;
const FULL_DDL = LEGACY_DDL.replace('synced INTEGER', 'active_app TEXT, active_app_bundle TEXT, active_title TEXT, active_url TEXT, synced INTEGER');
const PARTIAL_DDL = LEGACY_DDL.replace('synced INTEGER', 'active_app TEXT, synced INTEGER');

function seedRow(rng: Rng, active: 'none' | 'app' | 'all'): string {
  const cols = ['id', 'time_entry_id', 'bucket_start', 'keystrokes', 'clicks', 'mouse_dist_px', 'scroll_events', 'iki_cv', 'move_speed_cv', 'path_straight', 'synced'];
  const values = [lit(id(rng)), lit(maybeText(rng)), lit(bucket(rng)), lit(count(rng)), lit(count(rng)), lit(count(rng)), lit(count(rng)),
    lit(rng.chance(0.3) ? null : ratio(rng)), lit(rng.chance(0.3) ? null : ratio(rng)), lit(rng.chance(0.3) ? null : ratio(rng)), lit(rng.int(0, 1))];
  if (active !== 'none') {
    cols.push('active_app');
    values.push(lit(maybeText(rng)));
  }
  if (active === 'all') {
    cols.push('active_title', 'active_url');
    values.push(lit(maybeText(rng)), lit(maybeText(rng)));
  }
  return `INSERT OR IGNORE INTO activity_samples (${cols.join(', ')}) VALUES (${values.join(', ')})`;
}

function genPre(rng: Rng): string[] {
  const scenario = rng.weighted<'none' | 'legacy' | 'partial' | 'full' | 'broken'>([['none', 44], ['legacy', 25], ['partial', 11], ['full', 16], ['broken', 4]]);
  if (scenario === 'none') return [];
  if (scenario === 'broken') return ['CREATE TABLE activity_samples (id TEXT)'];
  const ddl = scenario === 'legacy' ? LEGACY_DDL : scenario === 'partial' ? PARTIAL_DDL : FULL_DDL;
  const rows = Array.from({ length: smallCount(rng, 0, 6) }, () => seedRow(rng, scenario === 'legacy' ? 'none' : scenario === 'partial' ? 'app' : 'all'));
  return [ddl, ...rows];
}

function genRow(rng: Rng, ids: string[]): ActivityRow {
  const reuse = ids.length > 0 && rng.chance(0.08);
  const rowId = reuse ? rng.pick(ids) : id(rng);
  ids.push(rowId);
  return {
    id: rowId,
    timeEntryId: maybeText(rng),
    bucketStart: bucket(rng),
    keystrokes: count(rng),
    clicks: count(rng),
    mouseDistancePx: count(rng),
    scrollEvents: count(rng),
    ikiCv: rng.chance(0.3) ? null : ratio(rng),
    moveSpeedCv: rng.chance(0.3) ? null : ratio(rng),
    pathStraightness: rng.chance(0.3) ? null : ratio(rng),
    activeApp: maybeText(rng),
    activeAppBundle: maybeText(rng),
    activeTitle: maybeText(rng),
    activeUrl: maybeText(rng),
    synced: rng.pick([0, 0, 0, 1]),
  };
}

const limit = (rng: Rng): number => rng.weighted<number>([[rng.int(0, 10), 60], [1, 10], [-1, 8], [1000, 14], [rng.pick([2.5, 0.5, 1e300]), 4], [0, 4]]);
const window = (rng: Rng): number => rng.weighted<number>([[T0 + rng.int(-3000, 3000) * MIN, 60], [rng.pick(REAL_ROWS), 10], [bucket(rng), 20], [rng.pick([0, -1, 1e300, 2 ** 53]), 10]]);

function genOp(rng: Rng, ids: string[]): Op {
  return rng.weighted<() => Op>([
    [() => ({ op: 'insert', row: genRow(rng, ids) }), 38],
    [() => ({ op: 'unsynced', limit: limit(rng) }), 12],
    [() => ({ op: 'markSynced', ids: Array.from({ length: smallCount(rng, 0, 5) }, () => (ids.length > 0 && rng.chance(0.85) ? rng.pick(ids) : id(rng))) }), 14],
    [() => ({ op: 'scrub', policy: { captureApps: rng.chance(0.5), captureTitles: rng.chance(0.5), captureUrls: rng.chance(0.5) } }), 8],
    [() => ({ op: 'countSince', sinceMs: window(rng) }), 8],
    [() => ({ op: 'aggregate', fromMs: window(rng), toMs: window(rng) }), 12],
    [() => ({ op: 'reopen' }), 3],
    [() => ({ op: 'exec', sql: rng.pick(['DELETE FROM activity_samples WHERE synced = 1', 'UPDATE activity_samples SET synced = 0', 'DELETE FROM activity_samples', 'DELETE FROM activity_samples WHERE rowid % 2 = 0']) }), 2],
  ])();
}

const everyPolicy: Op[] = [false, true].flatMap((captureApps) =>
  [false, true].flatMap((captureTitles) => [false, true].map((captureUrls) => ({ op: 'scrub', policy: { captureApps, captureTitles, captureUrls } }) as Op)),
);

const baseRow: ActivityRow = {
  id: 'a1', timeEntryId: 'te1', bucketStart: T0, keystrokes: 10, clicks: 2, mouseDistancePx: 300, scrollEvents: 1,
  ikiCv: 0.5, moveSpeedCv: null, pathStraightness: 0.9, activeApp: 'Safari', activeAppBundle: 'com.apple.Safari', activeTitle: 'T', activeUrl: 'https://x.test', synced: 0,
};

const spec: FnSpec<Input> = {
  crate: 'timo-store',
  module,
  fn: 'activityStore',
  edge: () => [
    { pre: [], ops: [] },
    { pre: [], ops: [{ op: 'insert', row: baseRow }, { op: 'insert', row: baseRow }, ...everyPolicy, { op: 'unsynced', limit: 10 }] },
    { pre: [], ops: [{ op: 'insert', row: { ...baseRow, bucketStart: REAL_ROWS[0]!, keystrokes: 0.5, clicks: 1e300, ikiCv: 1 } }, { op: 'unsynced', limit: 5 }, { op: 'aggregate', fromMs: 0, toMs: 2 ** 53 }, { op: 'countSince', sinceMs: -1 }] },
    { pre: [LEGACY_DDL, "INSERT INTO activity_samples (id, bucket_start, keystrokes, clicks, mouse_dist_px, scroll_events, synced) VALUES ('old', 1791133383891.2627, 3, 4, 5, 6, 0)"], ops: [{ op: 'reopen' }, { op: 'unsynced', limit: 5 }, { op: 'scrub', policy: { captureApps: false, captureTitles: true, captureUrls: true } }] },
    { pre: ['CREATE TABLE activity_samples (id TEXT)'], ops: [{ op: 'unsynced', limit: 1 }] },
    { pre: [], ops: [{ op: 'insert', row: baseRow }, { op: 'exec', sql: 'DROP TABLE activity_samples' }, { op: 'unsynced', limit: 1 }, { op: 'reopen' }, { op: 'insert', row: baseRow }] },
    { pre: [], ops: [{ op: 'markSynced', ids: [] }, { op: 'markSynced', ids: ['nope'] }, { op: 'unsynced', limit: -1 }, { op: 'countSince', sinceMs: 0 }, { op: 'aggregate', fromMs: 5, toMs: 1 }] },
  ],
  random: (rng) => {
    const ids: string[] = [];
    return { pre: genPre(rng), ops: Array.from({ length: smallCount(rng, 1, 45) }, () => genOp(rng, ids)) };
  },
  call: (input) =>
    runCase(
      input,
      (db) => new ActivityStore(db),
      (store, op) => {
        switch (op.op) {
          case 'insert': return store.insert(op.row);
          case 'unsynced': return store.unsynced(op.limit);
          case 'markSynced': return store.markSynced(op.ids);
          case 'scrub': return store.scrubActiveFields(op.policy);
          case 'countSince': return store.countSince(op.sinceMs);
          case 'aggregate': return store.aggregate(op.fromMs, op.toMs);
          default: throw new Error(`unexpected op ${op.op}`);
        }
      },
    ),
};

export const specs: FnSpec<any>[] = [spec];
