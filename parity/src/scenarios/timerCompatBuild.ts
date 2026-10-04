import Database from 'better-sqlite3';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { loadLegacy } from '../legacyStubs/register';
import { plain } from '../gen/seq';
import { scratchDir } from './timerCompat';
import { dumpEntries, dumpMeta } from './timerWorld';
import { SHAPES, historicalText } from './timerHistory';

/* The legacy modules, loaded through the stub hooks. */
type Json = Record<string, unknown>;
interface Store {
  bindOwner(owner: unknown): void;
  claimUnownedEntries(owner: unknown): number;
  claimServerMatchedEntries(owner: unknown, matches: unknown): number;
  upsert(entry: unknown, opts?: { syncState?: string }): string;
  switchEntry(closed: unknown, next: unknown): unknown;
  getOpen(): unknown;
  getUnsynced(): unknown;
  hasUnsynced(): boolean;
  isPendingCreate(id: string): boolean;
  listRecent(limit: number): unknown;
  listSince(since: number): unknown;
  listLedgerEntries(since: number): unknown;
  markCreated(id: string, entry: unknown): boolean;
  markPendingCreate(id: string, entry: unknown): boolean;
  markSynced(id: string, entry: unknown, ack: unknown): boolean;
  setLiveness(ts: number): void;
  getLiveness(): number | null;
  setExitIntent(v: unknown): void;
  getExitIntent(): unknown;
  clearExitIntent(): void;
  setAwayState(v: unknown): void;
  getAwayState(): unknown;
  clearAwayState(): void;
  setRecoveryNotice(v: unknown): void;
  getRecoveryNotice(): unknown;
  clearRecoveryNotice(): void;
}
interface Cache {
  replaceSnapshot(owner: unknown, window: unknown, response: unknown, fetchedAt?: number): void;
  list(owner: unknown, start: number, end: number, now: number): unknown;
}
const { SqliteEntryStore } = await loadLegacy<{ SqliteEntryStore: new (db: Database.Database) => Store }>('services/timer/sqliteStore.ts');
const { SqliteTodayLedgerStore } = await loadLegacy<{ SqliteTodayLedgerStore: new (db: Database.Database) => Cache }>('services/timer/todayLedgerStore.ts');
const { createTimeEntry, closeTimeEntry, closeOpenSegment } = await import('@grind/core');

const ME = { userId: 'user-1', workspaceId: 'ws-1' };
const OTHER = { userId: 'user-2', workspaceId: 'ws-1' };
const X = 1791133383891.2627;
const Y = 1791133448770.0293;
const iso = (ms: number): string => new Date(ms).toISOString();

const entryAt = (id: string, user: string, startedAt: number) =>
  createTimeEntry({ id, clientUuid: `client-${id}`, userId: user, larkTaskGuid: id === 'E1' ? 'task-a' : null, source: 'AUTO', startedAt, segmentId: `seg-${id}` });

function serverEntry(id: string, start: number, end: number | null): Json {
  return {
    id, clientUuid: `client-${id}`, userId: 'user-1', larkTaskGuid: null, source: 'AUTO', trackingProtocolVersion: 2, revision: 2,
    lastProvenAt: iso(start + 5000), leaseExpiresAt: iso(start + 8000), closeReason: null, serverFinalizedAt: null,
    startedAt: iso(start), endedAt: end === null ? null : iso(end), notes: null,
    segments: [{ id: `seg-${id}`, kind: 'WORK', startedAt: iso(start), endedAt: end === null ? null : iso(end) }],
  };
}

const WINDOW = { start: 1791071400000, end: 1791157800000 };
const snapshot = (): Json => ({
  complete: true, serverTime: iso(X + 90_000), workspaceTimezone: 'Asia/Kolkata',
  entries: [serverEntry('S1', X - 600_000, X - 300_000), serverEntry('S2', X - 120_000, null)],
  effectiveEntries: [
    { entryId: 'S1', endedAt: iso(X - 300_000), segments: [{ segmentId: 'seg-S1', endedAt: iso(X - 300_000) }] },
    { entryId: 'S2', endedAt: iso(X - 100_000), segments: [{ segmentId: 'seg-S2', endedAt: iso(X - 100_000) }] },
  ],
});

/** Build the database the way the legacy app would have left it. */
function populate(file: string): void {
  const db = new Database(file);
  const store = new SqliteEntryStore(db);
  const cache = new SqliteTodayLedgerStore(db);
  store.bindOwner(ME);
  const e1 = entryAt('E1', 'user-1', X);
  store.upsert(e1, { syncState: 'pending_create' });
  store.markCreated('E1', e1);
  const e2 = closeTimeEntry(entryAt('E2', 'user-1', X - 900_000.5), Y - 600_000);
  store.upsert(e2);
  store.markSynced('E2', e2, { revision: e2.revision, hash: 'ab'.repeat(32) });
  const e3 = closeTimeEntry(entryAt('E3', 'user-1', X - 400_000.25), X - 350_000.75);
  store.upsert(e3);
  store.setLiveness(1791133383891.9998);
  store.setExitIntent({ reason: 'quit', entryId: 'E3', observedAt: X - 350_000.75 });
  store.setAwayState({ reason: 'suspend', entryId: 'E1', awayStartedAt: X + 0.5, observedAt: X + 1000.125 });
  store.setRecoveryNotice({ entryId: 'E2', recoveredAt: Y - 600_000, reason: 'unexpected_shutdown', observedAt: Y });
  store.bindOwner(OTHER);
  store.upsert(entryAt('E4', 'user-2', X - 50_000.5));
  store.setLiveness(1791133000000.5);
  store.bindOwner(ME);
  const legacyRow = (id: string, user: string, endedAt: number | null) => {
    const e = endedAt === null ? entryAt(id, user, X - 777.5) : closeTimeEntry(entryAt(id, user, X - 777.5), endedAt);
    db.prepare('INSERT INTO local_entries (id, client_uuid, ended_at, synced, sync_state, json) VALUES (?, ?, ?, 0, ?, ?)')
      .run(e.id, e.clientUuid, e.endedAt, 'pending_create', JSON.stringify(e));
  };
  legacyRow('L1', 'user-1', X - 500.125);
  legacyRow('L2', 'self', X - 400.5);
  legacyRow('L3', 'user-1', null);
  // Rows as each released agent wrote them (timerHistory.ts): owned, and unowned for the claim.
  for (const shape of SHAPES) {
    const insert = (id: string, user: string, owner: string | null, state: string) => {
      const closed = X - 321.5;
      db.prepare('INSERT INTO local_entries (id, client_uuid, ended_at, synced, sync_state, owner_user_id, owner_workspace_id, json) VALUES (?, ?, ?, 0, ?, ?, ?, ?)')
        .run(id, `client_${id}`, closed, state, owner, owner === null ? null : ME.workspaceId, historicalText(shape, id, user, closed).replaceAll('1700000000000.25', String(X - 5000.25)));
    };
    insert(`Hown_${shape}`, 'user-1', 'user-1', 'pending_create');
    insert(`Hun_${shape}`, 'user-1', null, 'pending_create');
  }
  cache.replaceSnapshot(ME, WINDOW, snapshot(), 1791133450000.5);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.pragma('journal_mode = DELETE');
  db.close();
}

type Step = { op: string } & Json;

/** The script both implementations run on the reopened file. */
function script(): Step[] {
  const e1 = entryAt('E1', 'user-1', X);
  const paused = { ...closeOpenSegment(e1, X + 12_345.678), pauseReason: 'MANUAL' as const };
  const e5 = entryAt('E5', 'user-1', X + 20_000.25);
  const closedE1 = closeTimeEntry(paused, X + 15_000.5);
  const e3 = closeTimeEntry(entryAt('E3', 'user-1', X - 400_000.25), X - 350_000.75);
  return [
    { op: 'bind', owner: ME },
    { op: 'getOpen' }, { op: 'getUnsynced' }, { op: 'hasUnsynced' },
    { op: 'isPendingCreate', id: 'E1' }, { op: 'isPendingCreate', id: 'E2' }, { op: 'isPendingCreate', id: 'L1' },
    { op: 'listRecent', limit: 10 }, { op: 'listSince', since: X - 450_000 }, { op: 'listLedgerEntries', since: X - 450_000 },
    { op: 'getLiveness' }, { op: 'getExitIntent' }, { op: 'getAwayState' }, { op: 'getRecoveryNotice' },
    { op: 'cacheList', start: WINDOW.start, end: WINDOW.end, now: X + 1 }, { op: 'cacheList', start: WINDOW.start, end: WINDOW.end + 1, now: X },
    { op: 'upsert', entry: paused, syncState: null },
    { op: 'markSynced', id: 'E1', entry: e1, revision: 1, hash: 'cd'.repeat(32) },
    { op: 'markSynced', id: 'E3', entry: e3, revision: 2, hash: 'ef'.repeat(32) },
    { op: 'markPendingCreate', id: 'E2', entry: closeTimeEntry(entryAt('E2', 'user-1', X - 900_000.5), Y - 600_000) },
    { op: 'upsert', entry: e3, syncState: null },
    { op: 'setLiveness', ts: X + 99.0625 }, { op: 'getLiveness' },
    { op: 'clearExitIntent' }, { op: 'getExitIntent' },
    { op: 'setRecoveryNotice', value: { entryId: 'E1', recoveredAt: X + 0.5, reason: 'sleep_stop', observedAt: X + 1.5 } }, { op: 'getRecoveryNotice' },
    { op: 'clearAwayState' }, { op: 'clearRecoveryNotice' }, { op: 'getRecoveryNotice' },
    { op: 'claimUnowned', owner: ME }, { op: 'claimMatched', owner: ME, pairs: [{ id: 'L2', clientUuid: 'client-L2' }, { id: 'L3', clientUuid: 'client-L3' }] },
    { op: 'getUnsynced' },
    { op: 'switchEntry', closed: closedE1, next: e5 }, { op: 'getOpen' }, { op: 'listLedgerEntries', since: 0 },
    { op: 'bind', owner: OTHER }, { op: 'getOpen' }, { op: 'getLiveness' }, { op: 'listRecent', limit: 3 },
    { op: 'bind', owner: ME }, { op: 'getUnsynced' },
    // Historical row shapes: read back, then the guards against the row as stored, a mutation, the guards again.
    ...SHAPES.flatMap((shape) => [`Hown_${shape}`, `Hun_${shape}`].flatMap((id) => [
      { op: 'readEntry', id },
      { op: 'markFromRead', fn: 'markPendingCreate', id },
      { op: 'markFromRead', fn: 'markCreated', id },
      { op: 'mutateFromRead', id },
      { op: 'markFromRead', fn: 'markCreated', id },
      { op: 'markFromRead', fn: 'markSynced', id },
      { op: 'readEntry', id },
    ])),
  ];
}

/** The entry as the store hands it back (what the service keeps in memory and later passes to `mark*`). */
function readBack(store: Store, id: string): unknown {
  const rows = store.listLedgerEntries(0) as Array<{ entry: { id: string } }>;
  const found = rows.find((row) => row.entry.id === id);
  if (!found) throw new Error(`no row ${id}`);
  return found.entry;
}

function runStep(store: Store, cache: Cache, step: Step): unknown {
  const s = step as Json & { op: string };
  switch (s.op) {
    case 'bind': store.bindOwner(s.owner); return null;
    case 'getOpen': return store.getOpen();
    case 'getUnsynced': return store.getUnsynced();
    case 'hasUnsynced': return store.hasUnsynced();
    case 'isPendingCreate': return store.isPendingCreate(s.id as string);
    case 'listRecent': return store.listRecent(s.limit as number);
    case 'listSince': return store.listSince(s.since as number);
    case 'listLedgerEntries': return store.listLedgerEntries(s.since as number);
    case 'getLiveness': return store.getLiveness();
    case 'getExitIntent': return store.getExitIntent();
    case 'getAwayState': return store.getAwayState();
    case 'getRecoveryNotice': return store.getRecoveryNotice();
    case 'cacheList': return cache.list(ME, s.start as number, s.end as number, s.now as number);
    case 'upsert': return store.upsert(s.entry, s.syncState ? { syncState: s.syncState as string } : undefined);
    case 'markSynced': return store.markSynced(s.id as string, s.entry, { revision: s.revision, hash: s.hash });
    case 'markPendingCreate': return store.markPendingCreate(s.id as string, s.entry);
    case 'setLiveness': store.setLiveness(s.ts as number); return null;
    case 'clearExitIntent': store.clearExitIntent(); return null;
    case 'setRecoveryNotice': store.setRecoveryNotice(s.value); return null;
    case 'clearAwayState': store.clearAwayState(); return null;
    case 'clearRecoveryNotice': store.clearRecoveryNotice(); return null;
    case 'claimUnowned': return store.claimUnownedEntries(s.owner);
    case 'claimMatched': return store.claimServerMatchedEntries(s.owner, s.pairs);
    case 'switchEntry': return store.switchEntry(s.closed, s.next);
    case 'readEntry': return readBack(store, s.id as string);
    case 'mutateFromRead': {
      const entry = readBack(store, s.id as string) as { revision: number };
      return store.upsert({ ...entry, revision: entry.revision + 1 });
    }
    case 'markFromRead': {
      const entry = readBack(store, s.id as string) as { revision: number };
      if (s.fn === 'markSynced') return store.markSynced(s.id as string, entry, { revision: entry.revision, hash: 'ab'.repeat(32) });
      return s.fn === 'markCreated' ? store.markCreated(s.id as string, entry) : store.markPendingCreate(s.id as string, entry);
    }
    default: throw new Error(`unknown compat op ${s.op}`);
  }
}

export function buildCompat(): string {
  const dir = scratchDir();
  try {
    const file = join(dir, 'agent.db');
    populate(file);
    const bytes = readFileSync(file);
    const db = new Database(file);
    const store = new SqliteEntryStore(db);
    const cache = new SqliteTodayLedgerStore(db);
    const steps = script();
    const out: unknown[] = [];
    for (const step of steps) {
      let result: unknown;
      try {
        result = { ok: runStep(store, cache, step) ?? null };
      } catch (error) {
        result = { error: error instanceof Error ? error.message : String(error) };
      }
      out.push({ result, entries: dumpEntries(db), meta: dumpMeta(db) });
    }
    db.close();
    const fixture = { fn: 'compat', seed: 0, cases: [{ input: { script: steps }, output: { dbBase64: bytes.toString('base64'), steps: plain(out) } }] };
    return `${JSON.stringify({ ...fixture, cases: fixture.cases.map((c) => ({ input: plain(c.input), output: c.output })) }, null, 2)}\n`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
