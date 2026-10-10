import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/timo-signout-test' } }));

const { SignOutSyncLedger, syncBeforeSignOut } = await import('./signOutSync');

const ALICE = { userId: 'alice', workspaceId: 'w1' };

type Row = { id: string; state?: string; attempts?: number; error?: string | null; nextAt?: number | null; owner?: string };

function queue(rows: Row[]) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE local_entries (
    id TEXT PRIMARY KEY, sync_state TEXT NOT NULL, owner_user_id TEXT, owner_workspace_id TEXT,
    sync_attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER, last_error TEXT
  )`);
  const insert = db.prepare(`INSERT INTO local_entries VALUES (?, ?, ?, 'w1', ?, ?, ?)`);
  for (const r of rows) {
    insert.run(r.id, r.state ?? 'pending_create', r.owner ?? 'alice', r.attempts ?? 0, r.nextAt ?? null, r.error ?? null);
  }
  return { db, ledger: new SignOutSyncLedger(db) };
}

/** A drain that syncs up to `perPass` due rows, and fails the ones named in `refuse` with that error. */
function fakeDrain(db: Database.Database, perPass: number, refuse: Record<string, string> = {}) {
  return vi.fn(async () => {
    const due = db.prepare(
      `SELECT id FROM local_entries WHERE sync_state <> 'synced' AND next_attempt_at IS NULL ORDER BY id LIMIT ?`,
    ).all(perPass) as { id: string }[];
    for (const { id } of due) {
      if (refuse[id]) {
        db.prepare(`UPDATE local_entries SET sync_attempts = sync_attempts + 1, last_error = ?, next_attempt_at = 9e15 WHERE id = ?`)
          .run(refuse[id], id);
      } else {
        db.prepare(`UPDATE local_entries SET sync_state = 'synced', last_error = NULL WHERE id = ?`).run(id);
      }
    }
  });
}

describe('syncBeforeSignOut', () => {
  it('drains a backlog longer than one pass, including rows waiting out a backoff', async () => {
    const rows: Row[] = Array.from({ length: 60 }, (_, i) => ({ id: `e${String(i).padStart(2, '0')}`, nextAt: 9e15 }));
    const { db, ledger } = queue(rows);
    const drain = fakeDrain(db, 25);

    const result = await syncBeforeSignOut({ ledger, owner: ALICE, drain });

    expect(result).toEqual({ ok: true, backlog: { pending: 0, transient: 0, refused: 0, parked: 0 } });
    expect(drain).toHaveBeenCalledTimes(3);
  });

  it('lets sign-out through when only entries the server refused remain', async () => {
    const { db, ledger } = queue([
      { id: 'parked', attempts: 7, error: 'http_400:invalid_entry', nextAt: 9e15 },
      { id: 'ok' },
    ]);

    const result = await syncBeforeSignOut({
      ledger,
      owner: ALICE,
      drain: fakeDrain(db, 25, { parked: 'http_400:invalid_entry' }),
    });

    expect(result.ok).toBe(true);
    expect(result.backlog).toEqual({ pending: 1, transient: 0, refused: 1, parked: 1 });
  });

  it('agrees with the timer: a 403 or an unacknowledged push is a refusal, not a reason to wait', async () => {
    // The timer backs these off and parks them as row failures; sign-out used
    // to read them as transient and refused forever.
    const { db, ledger } = queue([{ id: 'forbidden' }, { id: 'unacked' }]);

    const result = await syncBeforeSignOut({
      ledger,
      owner: ALICE,
      drain: fakeDrain(db, 25, { forbidden: 'http_403:forbidden', unacked: 'unacknowledged_receipt' }),
    });

    expect(result.ok).toBe(true);
    expect(result.backlog).toMatchObject({ pending: 2, transient: 0, refused: 2 });
  });

  it('refuses while an entry is failing on the network or a 5xx', async () => {
    const { db, ledger } = queue([{ id: 'offline' }, { id: 'server' }]);

    const result = await syncBeforeSignOut({
      ledger,
      owner: ALICE,
      drain: fakeDrain(db, 25, { offline: 'ApiNetworkError:/v1/time-entries unreachable', server: 'http_503' }),
    });

    expect(result.ok).toBe(false);
    expect(result.backlog).toMatchObject({ pending: 2, transient: 2 });
  });

  it('only looks at the signing-out account\'s entries', async () => {
    const { db, ledger } = queue([{ id: 'bobs', owner: 'bob', error: 'http_503' }]);
    const drain = fakeDrain(db, 0);
    expect(await syncBeforeSignOut({ ledger, owner: ALICE, drain })).toMatchObject({ ok: true });
    expect(drain).not.toHaveBeenCalled();
  });

  it('is a no-op without an owner or a timer queue', async () => {
    const ledger = new SignOutSyncLedger(new Database(':memory:'));
    const drain = vi.fn(async () => undefined);
    expect((await syncBeforeSignOut({ ledger, owner: null, drain })).ok).toBe(true);
    expect((await syncBeforeSignOut({ ledger, owner: ALICE, drain })).ok).toBe(true);
  });
});
