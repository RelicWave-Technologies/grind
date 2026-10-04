import Database from 'better-sqlite3';
import { plain } from './seq';

/**
 * Shared machinery for the persistence generators (`store*.ts`).
 *
 * A case is a seeded OPERATION SEQUENCE: some SQL that pre-seeds the database
 * (legacy-shaped schemas, damaged rows), then calls on the real TypeScript store
 * class. Every call's return value (or thrown message) is recorded, and so is a
 * dump of the whole database at the end. The Rust test replays the same sequence
 * through the Rust store on an in-memory database and demands the same dump.
 */

export type Db = InstanceType<typeof Database>;

export function openMemory(): Db {
  return new Database(':memory:');
}

/** One call's outcome: its return value, or the message it threw. */
export type Outcome = { ok: unknown } | { error: string };

export function attempt(fn: () => unknown): Outcome {
  try {
    const value = fn();
    return { ok: value === undefined ? null : value };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Everything in `sqlite_master` plus every table's `table_info` and rows, with SQLite's own `typeof` per value. */
export function dumpDb(db: Db): unknown {
  const master = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY name`).raw(true).all();
  const names = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .pluck()
    .all() as string[];
  const tables = names.map((name) => {
    const quoted = `"${name.replace(/"/g, '""')}"`;
    const info = db.prepare(`PRAGMA table_info(${quoted})`).raw(true).all() as unknown[][];
    const columns = info.map((row) => `"${String(row[1]).replace(/"/g, '""')}"`);
    const select = columns.map((c) => `${c}, typeof(${c})`).join(', ');
    const rows = db.prepare(`SELECT ${select} FROM ${quoted} ORDER BY rowid`).raw(true).all() as unknown[][];
    return { name, info, rows: rows.map(pairs) };
  });
  return { master, tables };
}

/** `[v1, t1, v2, t2, ...]` into `[[v1, t1], [v2, t2], ...]`. */
function pairs(row: unknown[]): unknown[][] {
  const out: unknown[][] = [];
  for (let i = 0; i < row.length; i += 2) out.push([row[i], row[i + 1]]);
  return out;
}

/** A SQL literal for a JS value (the pre-seed statements are plain SQL text). */
export function lit(value: string | number | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

export interface StoreCase<Op> {
  /** SQL run on the empty database before the store is constructed. */
  pre: string[];
  ops: Op[];
}

/** The recorded output of a run: one outcome per step (construction first), then the dump. */
export interface StoreRun {
  results: Outcome[];
  dump: unknown;
}

/**
 * Drives a store through a case. `make` builds the store (it may throw), `apply`
 * performs one op on it. An op that is `{ op: 'reopen' }` builds a second store
 * over the same database (a reboot); `{ op: 'exec', sql }` runs raw SQL.
 */
export function runCase<S, Op extends { op: string }>(
  input: StoreCase<Op>,
  make: (db: Db, op: Op | null) => S,
  apply: (store: S, op: Op) => unknown,
): unknown {
  const db = openMemory();
  const results: Outcome[] = [];
  for (const sql of input.pre) db.exec(sql);
  const held: { store: S | null } = { store: null };
  const build = (op: Op | null): Outcome => {
    const outcome = attempt(() => {
      held.store = make(db, op);
    });
    if ('error' in outcome) held.store = null;
    return outcome;
  };
  results.push(build(null));
  for (const op of input.ops) {
    if (op.op === 'reopen') results.push(build(op));
    else if (op.op === 'exec') results.push(attempt(() => { db.exec((op as unknown as { sql: string }).sql); }));
    else results.push(attempt(() => (held.store === null ? failNoStore() : apply(held.store, op))));
  }
  const run: StoreRun = { results, dump: dumpDb(db) };
  db.close();
  return plain(run);
}

function failNoStore(): never {
  throw new Error('no store');
}
