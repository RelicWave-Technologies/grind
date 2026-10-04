import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureRoot } from '../fixture';

/**
 * The database-compatibility fixture: an `agent.db` written by the LEGACY
 * `SqliteEntryStore` / `SqliteTodayLedgerStore` (fractional timestamps, several
 * owners, unowned legacy rows, meta, a server snapshot), as base64, plus what the
 * legacy store answers when it reads it back and what the database looks like
 * after each of a series of further writes. The Rust test (`timer_compat.rs`)
 * opens the bytes with its own store and must answer and write identically.
 *
 * Built in a child process (`timerChild.ts compat`) for the same reason the
 * scenarios are: the legacy code patches globals and loads through stub hooks.
 */
export function compatFiles(): Map<string, string> {
  const child = fileURLToPath(new URL('./timerChild.ts', import.meta.url));
  const run = spawnSync(process.execPath, ['--import', 'tsx', child, 'compat'], {
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (run.status !== 0) throw new Error(`timer compat child failed (status ${run.status})`);
  const path = join(fixtureRoot('timo-store'), 'timer', 'compat.json');
  return new Map([[path, run.stdout]]);
}

/** Scratch directory for the database file the child builds. */
export function scratchDir(): string {
  return mkdtempSync(join(tmpdir(), 'timo-compat-'));
}
