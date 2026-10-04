import { ScreenshotStore, type ScreenshotRow } from '../../../legacy/agent/src/main/services/capture/store';
import type { FnSpec } from '../fixture';
import type { Rng } from '../prng';
import { REAL_ROWS, T0, MIN, id, maybeFrac, ts } from './common';
import { runCase, lit, type StoreCase } from './storeDb';
import { count, maybeText, text } from './storeValues';
import { smallCount } from './seq';

const module = 'store';

type Op =
  | { op: 'insert'; row: ScreenshotRow }
  | { op: 'recent'; limit: number }
  | { op: 'find'; id: string }
  | { op: 'countSince'; sinceMs: number }
  | { op: 'pending'; limit: number; now: number }
  | { op: 'markUploading'; id: string }
  | { op: 'markUploaded'; id: string; key: string }
  | { op: 'markPending'; id: string; lastError?: string | null; nextAttemptAt?: number | null }
  | { op: 'markRetryScheduled'; id: string; lastError: string; nextAttemptAt: number }
  | { op: 'markTerminalFailed'; id: string; lastError: string; failedAt: number }
  | { op: 'resetFailedUploads' }
  | { op: 'uploadSummary' }
  | { op: 'allForRetention' }
  | { op: 'deleteByIds'; ids: string[] }
  | { op: 'reopen'; now: number }
  | { op: 'exec'; sql: string };

/** `now` is the `Date.now()` the constructor reads for the retry-cap repair. */
type Input = StoreCase<Op> & { now: number };

const FULL_DDL = `CREATE TABLE screenshots (
  id TEXT PRIMARY KEY, time_entry_id TEXT, display_id TEXT NOT NULL, captured_at INTEGER NOT NULL, file_path TEXT NOT NULL,
  bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, upload_state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0, s3_key TEXT, last_error TEXT, next_attempt_at INTEGER, failed_at INTEGER)`;
/** Before the retry columns existed, with the two indexes that did. */
const LEGACY_DDL = [
  `CREATE TABLE screenshots (
  id TEXT PRIMARY KEY, time_entry_id TEXT, display_id TEXT NOT NULL, captured_at INTEGER NOT NULL, file_path TEXT NOT NULL,
  bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, upload_state TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0, s3_key TEXT)`,
  'CREATE INDEX idx_shots_captured ON screenshots(captured_at)',
  'CREATE INDEX idx_shots_upload ON screenshots(upload_state)',
];
const META_DDL = 'CREATE TABLE capture_meta (key TEXT PRIMARY KEY, value TEXT)';
const MARKER = 'requeue:storage-outage-500';

const STATES = ['pending', 'pending', 'uploading', 'uploaded', 'failed', 'failed'];

function seedRow(rng: Rng, full: boolean): string {
  const cols = ['id', 'display_id', 'captured_at', 'file_path', 'bytes', 'width', 'height', 'upload_state', 'attempts'];
  const values = [lit(id(rng)), lit('d1'), lit(maybeFrac(rng, T0 + rng.int(0, 100) * MIN, 0.5)), lit(text(rng)), lit(rng.int(1, 9999)), lit(1920), lit(1080),
    lit(rng.chance(0.05) ? 'weird' : rng.pick(STATES)), lit(rng.pick([0, 1, 4, 5, 5, 6, 9, 0.5]))];
  if (full) {
    cols.push('last_error', 'next_attempt_at', 'failed_at');
    values.push(lit(maybeText(rng)), lit(rng.chance(0.5) ? null : T0 + rng.int(0, 50) * MIN), lit(rng.chance(0.6) ? null : T0 + rng.int(0, 50) * MIN));
  }
  return `INSERT OR IGNORE INTO screenshots (${cols.join(', ')}) VALUES (${values.join(', ')})`;
}

function genPre(rng: Rng): string[] {
  const scenario = rng.weighted<'none' | 'legacy' | 'full' | 'marked' | 'broken'>([['none', 28], ['legacy', 29], ['full', 19], ['marked', 20], ['broken', 4]]);
  if (scenario === 'none') return [];
  if (scenario === 'broken') return ['CREATE TABLE screenshots (id TEXT)'];
  const full = scenario !== 'legacy';
  const rows = Array.from({ length: smallCount(rng, 0, 8) }, () => seedRow(rng, full));
  const marker = scenario === 'marked' ? [META_DDL, `INSERT INTO capture_meta (key, value) VALUES ('${MARKER}', '${rng.int(0, 9)}')`] : [];
  return [...(full ? [FULL_DDL] : LEGACY_DDL), ...marker, ...rows];
}

function genRow(rng: Rng, ids: string[]): ScreenshotRow {
  const reuse = ids.length > 0 && rng.chance(0.06);
  const rowId = reuse ? rng.pick(ids) : id(rng);
  ids.push(rowId);
  const whole = (): number => T0 + rng.int(0, 5000) * MIN + rng.int(0, 59) * 1000;
  return {
    id: rowId,
    timeEntryId: maybeText(rng),
    displayId: rng.pick(['d1', 'd2', 'display-0', text(rng)]),
    capturedAt: rng.chance(0.15) ? rng.pick([...REAL_ROWS, 0, -1, 1e300, 2 ** 53]) : ts(rng),
    filePath: text(rng),
    bytes: count(rng),
    width: rng.pick([1920, 2560, 1440, count(rng)]),
    height: rng.pick([1080, 1440, 900, count(rng)]),
    uploadState: (rng.chance(0.04) ? 'weird' : rng.pick(STATES)) as ScreenshotRow['uploadState'],
    attempts: rng.pick([0, 0, 0, 1, 2, 4, 5, 6, 3.5]),
    s3Key: maybeText(rng),
    lastError: maybeText(rng, 0.5),
    nextAttemptAt: rng.chance(0.5) ? null : whole(),
    failedAt: rng.chance(0.7) ? null : whole(),
  };
}

const limit = (rng: Rng): number => rng.weighted<number>([[rng.int(0, 10), 60], [1, 10], [-1, 8], [1000, 14], [rng.pick([2.5, 1e300]), 4], [0, 4]]);
const nowMs = (rng: Rng): number => T0 + rng.int(-2000, 6000) * MIN + rng.pick([0, 0, 1, 999]);

function genOp(rng: Rng, ids: string[]): Op {
  const pick = (): string => (ids.length > 0 && rng.chance(0.85) ? rng.pick(ids) : id(rng));
  return rng.weighted<() => Op>([
    [() => ({ op: 'insert', row: genRow(rng, ids) }), 24],
    [() => ({ op: 'recent', limit: limit(rng) }), 6],
    [() => ({ op: 'find', id: pick() }), 5],
    [() => ({ op: 'countSince', sinceMs: rng.chance(0.7) ? ts(rng) : T0 }), 4],
    [() => ({ op: 'pending', limit: limit(rng), now: nowMs(rng) }), 10],
    [() => ({ op: 'markUploading', id: pick() }), 6],
    [() => ({ op: 'markUploaded', id: pick(), key: text(rng) }), 5],
    [() => genMarkPending(rng, pick()), 6],
    [() => ({ op: 'markRetryScheduled', id: pick(), lastError: text(rng), nextAttemptAt: nowMs(rng) }), 7],
    [() => ({ op: 'markTerminalFailed', id: pick(), lastError: text(rng), failedAt: nowMs(rng) }), 7],
    [() => ({ op: 'resetFailedUploads' }), 4],
    [() => ({ op: 'uploadSummary' }), 4],
    [() => ({ op: 'allForRetention' }), 3],
    [() => ({ op: 'deleteByIds', ids: Array.from({ length: smallCount(rng, 0, 4) }, pick) }), 5],
    [() => ({ op: 'reopen', now: nowMs(rng) }), 4],
    [() => ({ op: 'exec', sql: rng.pick(EXEC) }), 5],
  ])();
}

const EXEC = [
  'DELETE FROM capture_meta',
  'UPDATE screenshots SET attempts = attempts + 5',
  "UPDATE screenshots SET upload_state = 'uploading'",
  "UPDATE screenshots SET upload_state = 'failed', failed_at = NULL, last_error = NULL",
  "UPDATE screenshots SET upload_state = 'pending', attempts = 7 WHERE rowid % 2 = 0",
  "DELETE FROM capture_meta WHERE key LIKE '%'",
];

function genMarkPending(rng: Rng, target: string): Op {
  const op: Op = { op: 'markPending', id: target };
  const mode = rng.int(0, 3);
  if (mode >= 1) op.lastError = rng.chance(0.3) ? null : text(rng);
  if (mode >= 2) op.nextAttemptAt = rng.chance(0.3) ? null : nowMs(rng);
  return op;
}

const row = (over: Partial<ScreenshotRow> = {}): ScreenshotRow => ({
  id: 's1', timeEntryId: 'te', displayId: 'd1', capturedAt: REAL_ROWS[0]!, filePath: '/tmp/s1.webp', bytes: 100, width: 1920, height: 1080,
  uploadState: 'pending', attempts: 0, s3Key: null, lastError: null, nextAttemptAt: null, failedAt: null, ...over,
});

const spec: FnSpec<Input> = {
  crate: 'timo-store',
  module,
  fn: 'captureStore',
  edge: () => [
    { now: T0, pre: [], ops: [] },
    { now: T0, pre: LEGACY_DDL, ops: [{ op: 'reopen', now: T0 }] },
    {
      now: T0,
      pre: [FULL_DDL, shotSql('a', 'failed', 5), shotSql('b', 'uploaded', 1), shotSql('c', 'uploading', 2), shotSql('d', 'pending', 6)],
      ops: [{ op: 'uploadSummary' }, { op: 'reopen', now: T0 + 5 }, { op: 'uploadSummary' }, { op: 'pending', limit: 10, now: T0 }],
    },
    {
      now: 123,
      pre: [],
      ops: [
        { op: 'insert', row: row() }, { op: 'insert', row: row() }, { op: 'insert', row: row({ id: 's2', capturedAt: REAL_ROWS[1]!, lastError: 'é 😀 "q"\n', nextAttemptAt: T0 }) },
        { op: 'markRetryScheduled', id: 's1', lastError: 'boom', nextAttemptAt: T0 }, { op: 'markTerminalFailed', id: 's2', lastError: 'x', failedAt: T0 },
        { op: 'resetFailedUploads' }, { op: 'markPending', id: 's1' }, { op: 'markUploaded', id: 's1', key: 'k' }, { op: 'recent', limit: 5 }, { op: 'find', id: 'nope' },
        { op: 'deleteByIds', ids: [] }, { op: 'deleteByIds', ids: ['s1', 'zz'] }, { op: 'allForRetention' },
      ],
    },
    { now: 1, pre: [FULL_DDL], ops: [{ op: 'insert', row: row() }, { op: 'exec', sql: 'DROP TABLE capture_meta' }, { op: 'reopen', now: 2 }] },
    { now: 1, pre: ['CREATE TABLE screenshots (id TEXT)'], ops: [{ op: 'recent', limit: 1 }] },
  ],
  random: (rng) => {
    const ids: string[] = [];
    return { now: nowMs(rng), pre: genPre(rng), ops: Array.from({ length: smallCount(rng, 1, 45) }, () => genOp(rng, ids)) };
  },
  call: (input) =>
    runCase(
      input,
      (db, op) => withNow(op && op.op === 'reopen' ? op.now : input.now, () => new ScreenshotStore(db)),
      (store, op) => {
        switch (op.op) {
          case 'insert': return store.insert(op.row);
          case 'recent': return store.recent(op.limit);
          case 'find': return store.find(op.id);
          case 'countSince': return store.countSince(op.sinceMs);
          case 'pending': return store.pending(op.limit, op.now);
          case 'markUploading': return store.markUploading(op.id);
          case 'markUploaded': return store.markUploaded(op.id, op.key);
          case 'markPending': return store.markPending(op.id, op.lastError, op.nextAttemptAt);
          case 'markRetryScheduled': return store.markRetryScheduled(op.id, op.lastError, op.nextAttemptAt);
          case 'markTerminalFailed': return store.markTerminalFailed(op.id, op.lastError, op.failedAt);
          case 'resetFailedUploads': return store.resetFailedUploads();
          case 'uploadSummary': return store.uploadSummary();
          case 'allForRetention': return store.allForRetention();
          case 'deleteByIds': return store.deleteByIds(op.ids);
          default: throw new Error(`unexpected op ${op.op}`);
        }
      },
    ),
};

/** The constructor reads `Date.now()` for the retry-cap repair; pin it to the injected instant. */
function withNow<T>(now: number, fn: () => T): T {
  const real = Date.now;
  Date.now = () => now;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}

/** A hand-written seed row in a given state. */
function shotSql(rowId: string, state: string, attempts: number): string {
  return `INSERT INTO screenshots (id, display_id, captured_at, file_path, bytes, width, height, upload_state, attempts, failed_at, last_error)
    VALUES ('${rowId}', 'd', 1.5, '/tmp/${rowId}', 1, 1, 1, '${state}', ${attempts}, 1, 'boom')`;
}

export const specs: FnSpec<any>[] = [spec];
