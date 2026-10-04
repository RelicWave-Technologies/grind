import Database from 'better-sqlite3';
import { loadLegacy } from '../legacyStubs/register';
import { net, resetNet, type NetItem } from '../legacyStubs/timerState';
import { HttpError } from '../legacyStubs/timerApi';
import { plain } from '../gen/seq';
import { buildMalformed, buildReceipt, buildSnapshot, type SnapshotOp } from './timerReceipts';
import type {
  Delivery, DeliverySpec, Op, Scenario, Settled, StepRecord,
} from './timerTypes';
import { CounterIds, ScriptedGuard, World, dumpCache, dumpEntries, dumpMeta } from './timerWorld';

/* The legacy modules, loaded through the stub hooks. Only the shape used here is typed. */
type Json = Record<string, unknown>;
interface Svc {
  bindOwner(owner: unknown, claimLegacy?: boolean): void;
  claimServerMatchedEntries(matches: unknown): number;
  setMutationListener(fn: (() => void) | null): void;
  setTodayLedgerMode(mode: string): boolean;
  todayLedgerDiagnostics(now?: number): unknown;
  recover(at: number): unknown;
  recoverAway(): unknown;
  heartbeat(): void;
  lastLiveness(): number | null;
  start(args: Json): Promise<unknown>;
  stop(): Promise<unknown>;
  prepareForQuit(reason: string): Promise<unknown>;
  prepareForAway(reason: string, ms?: number): Promise<unknown>;
  resume(): Promise<unknown>;
  pause(): Promise<unknown>;
  pauseForIdle(ms: number): Promise<void>;
  pauseForPermission(ms?: number): Promise<unknown>;
  resumeFromIdle(at: number): Promise<void>;
  beginMeeting(at: number): Promise<void>;
  endMeeting(at: number): Promise<void>;
  discardAway(start: number, resume: number): Promise<void>;
  status(): unknown;
  listToday(now: number): unknown;
  workedMsByTask(now?: number): Map<string, number>;
  recoveryNotice(): unknown;
  dismissRecoveryNotice(): void;
  acceptServerFinalization(id: string, at: number): unknown;
  flushUnsynced(limit?: number): Promise<boolean>;
  hasUnsynced(): boolean;
  isPendingCreate(id: string): boolean;
}
interface TimerServiceModule {
  TimerService: new (store: unknown, sync: unknown, clock: unknown, ids: unknown, guard: unknown, day?: unknown, cache?: unknown) => Svc;
}
interface StoreModule { SqliteEntryStore: new (db: Database.Database) => unknown }
interface CacheModule { SqliteTodayLedgerStore: new (db: Database.Database) => { replaceSnapshot(o: unknown, w: unknown, r: unknown, f?: number): void } }
interface SyncModule { HttpSyncClient: new () => { create(e: unknown): Promise<unknown>; sync(e: unknown): Promise<unknown> } }
interface ClockModule {
  __resetServerClock(mono?: () => number): void;
  noteServerTime(iso: string, a: number, b: number): number | null;
  setServerClockTrackingActive(active: boolean): void;
  serverAlignedNow(): number;
}

const lib = {
  timer: await loadLegacy<TimerServiceModule>('services/timer/timerService.ts'),
  store: await loadLegacy<StoreModule>('services/timer/sqliteStore.ts'),
  cache: await loadLegacy<CacheModule>('services/timer/todayLedgerStore.ts'),
  sync: await loadLegacy<SyncModule>('services/timer/syncClient.ts'),
  clock: await loadLegacy<ClockModule>('services/serverClock.ts'),
};

const DAY = 86_400_000;
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function businessDay(spec: Scenario['setup']['businessDay']): unknown {
  if (spec.kind === 'utc') return undefined;
  if (spec.kind === 'none') return { window: () => null };
  if (spec.kind === 'fixed') return { window: () => ({ start: spec.start, end: spec.end }) };
  return {
    window(now: number) {
      const start = Math.floor((now + spec.offsetMs) / DAY) * DAY - spec.offsetMs;
      return { start, end: start + DAY };
    },
  };
}

function legacyTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE local_entries (
      id          TEXT PRIMARY KEY,
      client_uuid TEXT NOT NULL UNIQUE,
      ended_at    INTEGER,
      synced      INTEGER NOT NULL DEFAULT 0,
      json        TEXT NOT NULL
    );
    CREATE TABLE timer_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

function seed(db: Database.Database, rows: Scenario['setup']['seedRows'], legacy: boolean): void {
  for (const r of rows) {
    if (legacy) {
      db.prepare('INSERT INTO local_entries (id, client_uuid, ended_at, synced, json) VALUES (?, ?, ?, ?, ?)')
        .run(r.id, r.clientUuid, r.endedAt, r.synced, r.jsonText);
    } else {
      db.prepare(
        `INSERT INTO local_entries (id, client_uuid, ended_at, synced, sync_state, owner_user_id, owner_workspace_id,
           acknowledged_revision, acknowledged_hash, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(r.id, r.clientUuid, r.endedAt, r.synced, r.syncState ?? 'pending_create', r.ownerUserId, r.ownerWorkspaceId,
        r.acknowledgedRevision, r.acknowledgedHash, r.jsonText);
    }
  }
}

interface Flight { op: number; done: boolean; value?: unknown; error?: unknown; reported: boolean }

/** Runs one scenario against the REAL legacy TimerService, store, sync client and server clock. */
export async function runScenario(scenario: Scenario): Promise<StepRecord[]> {
  const { setup } = scenario;
  const world = new World(setup);
  resetNet();
  lib.clock.__resetServerClock(() => world.readMono());
  const realNow = Date.now;
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  Date.now = () => world.deviceNow();
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  const db = new Database(':memory:');
  try {
    if (setup.legacySchema) {
      legacyTables(db);
      seed(db, setup.seedRows, true);
    }
    const store = new lib.store.SqliteEntryStore(db);
    const cache = new lib.cache.SqliteTodayLedgerStore(db);
    if (!setup.legacySchema) seed(db, setup.seedRows, false);
    const guard = new ScriptedGuard();
    const ids = new CounterIds(setup.idStart);
    const real = new lib.sync.HttpSyncClient();
    const spy = {
      create: (entry: unknown) => { net.currentEntry = structuredClone(entry); return real.create(entry); },
      sync: (entry: unknown) => { net.currentEntry = structuredClone(entry); return real.sync(entry); },
    };
    const clock = { now: () => lib.clock.serverAlignedNow() };
    const svc = new lib.timer.TimerService(store, spy, clock, ids, guard, businessDay(setup.businessDay), cache);
    svc.setTodayLedgerMode(setup.mode);
    let listenerCount = 0;
    let listenerThrows = false;
    svc.setMutationListener(() => {
      listenerCount += 1;
      if (listenerThrows) throw new Error('listener failed');
    });
    if (setup.bind) svc.bindOwner(setup.owner, setup.claimLegacy);
    return await replay({ scenario, db, world, svc, guard, ids, cache, flightsOut: [], counters: () => listenerCount, setThrows: (v) => { listenerThrows = v; }, resetCounter: () => { listenerCount = 0; } });
  } finally {
    Date.now = realNow;
    if (platform) Object.defineProperty(process, 'platform', platform);
    db.close();
  }
}

interface Ctx {
  scenario: Scenario;
  db: Database.Database;
  world: World;
  svc: Svc;
  guard: ScriptedGuard;
  ids: CounterIds;
  cache: { replaceSnapshot(o: unknown, w: unknown, r: unknown, f?: number): void };
  flightsOut: Flight[];
  counters: () => number;
  setThrows: (v: boolean) => void;
  resetCounter: () => void;
}

function launch(ctx: Ctx, index: number, make: () => unknown): void {
  const flight: Flight = { op: index, done: false, reported: false };
  ctx.flightsOut.push(flight);
  let started: Promise<unknown>;
  try {
    started = Promise.resolve(make());
  } catch (error) {
    flight.done = true;
    flight.error = error;
    return;
  }
  started.then((value) => { flight.done = true; flight.value = value; }, (error: unknown) => { flight.done = true; flight.error = error; });
}

/** Pick the oldest `i`-th pending request, answer it as scripted, and record exactly what was sent back. */
function deliver(ctx: Ctx, index: number, spec: DeliverySpec): Delivery | null {
  if (net.pending.length === 0) return null;
  const item: NetItem = net.pending.splice(index % net.pending.length, 1)[0]!;
  const serverTimeMs = ctx.world.trueNow;
  if (spec.kind === 'http') {
    item.reject(new HttpError(item.path, spec.status, spec.body));
    return { id: item.id, rejectHttp: { status: spec.status, body: spec.body } };
  }
  if (spec.kind === 'neterr') {
    item.reject(new Error('network down'));
    return { id: item.id, rejectError: 'network down' };
  }
  const body = spec.kind === 'ok' ? buildReceipt(item, spec, serverTimeMs) : buildMalformed(item, spec.variant, serverTimeMs);
  const text = JSON.stringify(body);
  item.resolve(JSON.parse(text));
  return { id: item.id, resolve: text };
}

const OK_SERVER: DeliverySpec = { kind: 'ok', hash: 'server' };

/** Ops that may sit inside a burst: they must not need an answer recorded for the step. */
const BURSTABLE_EXCLUDED = new Set(['deliver', 'drain', 'snapshot', 'burst']);

/**
 * Several ops in ONE synchronous turn: nothing runs between them, not even a microtask. This is
 * the only way two calls can be suspended at the same time and resumed in the same checkpoint,
 * which is where the order of the `await`s after every commit becomes visible.
 */
function burst(ctx: Ctx, op: Op, index: number, record: StepRecord): void {
  for (const member of op.ops as Op[]) {
    if (BURSTABLE_EXCLUDED.has(member.op)) throw new Error(`${member.op} cannot be part of a burst`);
    runSyncOp(ctx, member, index, record);
  }
}

async function runOp(ctx: Ctx, op: Op, index: number, record: StepRecord): Promise<void> {
  if (op.op === 'drain') {
    const delivered: Delivery[] = [];
    for (let guard = 0; guard < 200 && net.pending.length > 0; guard++) {
      const one = deliver(ctx, 0, (op.spec as DeliverySpec | undefined) ?? OK_SERVER);
      if (one) delivered.push(one);
      await flush();
    }
    if (delivered.length > 0) record.deliveries = delivered;
    return;
  }
  runSyncOp(ctx, op, index, record);
}

function runSyncOp(ctx: Ctx, op: Op, index: number, record: StepRecord): void {
  const { svc, world } = ctx;
  const num = (key: string): number => op[key] as number;
  switch (op.op) {
    case 'start': launch(ctx, index, () => svc.start({ larkTaskGuid: op.guid as string | null })); break;
    case 'stop': launch(ctx, index, () => svc.stop()); break;
    case 'pause': launch(ctx, index, () => svc.pause()); break;
    case 'resume': launch(ctx, index, () => svc.resume()); break;
    case 'resumeFromIdle': launch(ctx, index, () => svc.resumeFromIdle(num('at'))); break;
    case 'pauseForIdle': launch(ctx, index, () => svc.pauseForIdle(num('ms'))); break;
    case 'pauseForPermission': launch(ctx, index, () => svc.pauseForPermission(num('ms'))); break;
    case 'prepareForQuit': launch(ctx, index, () => svc.prepareForQuit(op.reason as string)); break;
    case 'prepareForAway': launch(ctx, index, () => svc.prepareForAway(op.reason as string, num('ms'))); break;
    case 'discardAway': launch(ctx, index, () => svc.discardAway(num('start'), num('resume'))); break;
    case 'beginMeeting': launch(ctx, index, () => svc.beginMeeting(num('at'))); break;
    case 'endMeeting': launch(ctx, index, () => svc.endMeeting(num('at'))); break;
    case 'flush': launch(ctx, index, () => svc.flushUnsynced(op.limit === 'inf' ? Infinity : op.limit === null ? undefined : num('limit'))); break;
    case 'recover': launch(ctx, index, () => svc.recover(num('at'))); break;
    case 'recoverAway': launch(ctx, index, () => svc.recoverAway()); break;
    case 'heartbeat': launch(ctx, index, () => svc.heartbeat()); break;
    case 'lastLiveness': launch(ctx, index, () => svc.lastLiveness()); break;
    case 'recoveryNotice': launch(ctx, index, () => svc.recoveryNotice()); break;
    case 'dismissNotice': launch(ctx, index, () => svc.dismissRecoveryNotice()); break;
    case 'hasUnsynced': launch(ctx, index, () => svc.hasUnsynced()); break;
    case 'isPendingCreate': launch(ctx, index, () => svc.isPendingCreate(op.id as string)); break;
    case 'mode': launch(ctx, index, () => svc.setTodayLedgerMode(op.mode as string)); break;
    case 'listToday': launch(ctx, index, () => svc.listToday(num('at'))); break;
    case 'workedByTask': launch(ctx, index, () => [...svc.workedMsByTask(op.at === null ? undefined : num('at'))]); break;
    case 'diagnostics': launch(ctx, index, () => svc.todayLedgerDiagnostics(op.at === null ? undefined : num('at'))); break;
    case 'finalize': {
      const open = ctx.db.prepare('SELECT id FROM local_entries WHERE ended_at IS NULL ORDER BY rowid DESC LIMIT 1').get() as { id: string } | undefined;
      const id = op.entry === 'open' ? open?.id ?? 'none' : (op.entry as string);
      launch(ctx, index, () => svc.acceptServerFinalization(id, num('at')));
      break;
    }
    case 'bind': launch(ctx, index, () => svc.bindOwner(op.owner, op.claim as boolean)); break;
    case 'claimMatched': launch(ctx, index, () => svc.claimServerMatchedEntries(op.pairs)); break;
    case 'advance': world.advance(num('ms')); break;
    case 'suspend': world.suspend(num('ms')); break;
    case 'jumpDevice': world.skew += num('ms'); break;
    case 'noteServerTime': {
      const startedAt = world.deviceNow();
      world.advance(num('rtt') / 2);
      const stamped = new Date(world.trueNow + num('offset')).toISOString();
      world.advance(num('rtt') / 2);
      launch(ctx, index, () => lib.clock.noteServerTime(stamped, startedAt, world.deviceNow()));
      break;
    }
    case 'noteRaw': {
      const orNaN = (v: unknown): number => (v === null ? Number.NaN : (v as number));
      launch(ctx, index, () => lib.clock.noteServerTime(op.iso as string, orNaN(op.started), orNaN(op.received)));
      break;
    }
    case 'tracking': lib.clock.setServerClockTrackingActive(op.active as boolean); break;
    case 'guard': ctx.guard.mode = op.mode as 'allow' | 'deny' | 'hold'; break;
    case 'releaseGuard': ctx.guard.release(op.deny as boolean); break;
    case 'ids': ctx.ids.n = num('set'); break;
    case 'listener': ctx.setThrows(op.throws as boolean); break;
    case 'sql': launch(ctx, index, () => ctx.db.prepare(op.stmt as string).run(...(op.params as unknown[]))); break;
    case 'deliver': {
      const delivered = deliver(ctx, num('i'), op.spec as DeliverySpec);
      if (delivered) record.deliveries = [delivered];
      break;
    }
    case 'burst': burst(ctx, op, index, record); break;
    case 'snapshot': {
      const owner = ctx.scenario.setup.owner;
      const snapshotOp = op as unknown as SnapshotOp & { op: string };
      if (!owner) break;
      const response = buildSnapshot(ctx.db, owner, snapshotOp);
      record.snapshot = { window: snapshotOp.window, response, fetchedAt: world.deviceNow() };
      launch(ctx, index, () => ctx.cache.replaceSnapshot(owner, snapshotOp.window, response, world.deviceNow()));
      break;
    }
    default: throw new Error(`unknown op ${op.op}`);
  }
}

/** Replay the ops, recording the full state after every one. */
async function replay(ctx: Ctx): Promise<StepRecord[]> {
  const steps: StepRecord[] = [];
  const lastRows = new Map<number, string>();
  let lastMeta: string | null = null;
  let lastCache: string | null = null;
  for (const [index, op] of ctx.scenario.ops.entries()) {
    const record: StepRecord = {
      i: index, settled: [], status: null, calls: [], listener: 0, pending: 0, inflight: 0,
    };
    ctx.resetCounter();
    net.calls = [];
    await runOp(ctx, op, index, record);
    await flush();
    const settled: Settled[] = [];
    for (const flight of ctx.flightsOut) {
      if (flight.done && !flight.reported) {
        flight.reported = true;
        settled.push({ op: flight.op, result: flight.error !== undefined ? { error: message(flight.error) } : { ok: flight.value ?? null } });
      }
    }
    record.settled = settled;
    try {
      record.status = ctx.svc.status();
    } catch (error) {
      record.status = { error: message(error) };
    }
    record.calls = net.calls.map((c) => ({ ...c }));
    record.listener = ctx.counters();
    record.pending = net.pending.length;
    record.inflight = ctx.flightsOut.filter((f) => !f.done).length;
    // Only the rows that are new or changed since the previous step (rows are never deleted).
    const changed = dumpEntries(ctx.db).filter((row) => {
      const text = JSON.stringify(row);
      if (lastRows.get(row.rowid) === text) return false;
      lastRows.set(row.rowid, text);
      return true;
    });
    if (changed.length > 0) record.entries = changed;
    const meta = JSON.stringify(dumpMeta(ctx.db));
    if (meta !== lastMeta) { record.meta = JSON.parse(meta) as StepRecord['meta']; lastMeta = meta; }
    const cache = JSON.stringify(dumpCache(ctx.db));
    if (cache !== lastCache) { record.cache = JSON.parse(cache); lastCache = cache; }
    steps.push(plain(record) as StepRecord);
  }
  return steps;
}
