import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ScreenshotStore } from './store';

describe('ScreenshotStore migrations', () => {
  it('adds retry columns before creating indexes on older local databases', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE screenshots (
        id           TEXT PRIMARY KEY,
        time_entry_id TEXT,
        display_id   TEXT NOT NULL,
        captured_at  INTEGER NOT NULL,
        file_path    TEXT NOT NULL,
        bytes        INTEGER NOT NULL,
        width        INTEGER NOT NULL,
        height       INTEGER NOT NULL,
        upload_state TEXT NOT NULL DEFAULT 'pending',
        attempts     INTEGER NOT NULL DEFAULT 0,
        s3_key       TEXT
      );
      CREATE INDEX idx_shots_captured ON screenshots(captured_at);
      CREATE INDEX idx_shots_upload ON screenshots(upload_state);
    `);

    expect(() => new ScreenshotStore(db)).not.toThrow();

    const cols = db.prepare(`PRAGMA table_info(screenshots)`).all() as { name: string }[];
    expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(['last_error', 'next_attempt_at', 'failed_at']));
    const indexes = db.prepare(`PRAGMA index_list(screenshots)`).all() as { name: string }[];
    expect(indexes.map((i) => i.name)).toContain('idx_shots_next_attempt');
  });
});

describe('recovering a backlog written off during a storage outage', () => {
  /** A store over a fresh in-memory database, as the agent builds it. */
  const openStore = (db: InstanceType<typeof Database>) => new ScreenshotStore(db);

  const seed = (db: InstanceType<typeof Database>, rows: Array<{ id: string; state: string; attempts: number }>) => {
    for (const r of rows) {
      db.prepare(
        `INSERT INTO screenshots (id, display_id, captured_at, file_path, bytes, width, height, upload_state, attempts, failed_at, last_error)
         VALUES (?, 'd', 1, '/tmp/' || ?, 1, 1, 1, ?, ?, 1, 'boom')`,
      ).run(r.id, r.id, r.state, r.attempts);
    }
  };

  it('puts failed shots back in the queue, once', () => {
    const db = new Database(':memory:');
    openStore(db); // creates the schema
    seed(db, [
      { id: 'a', state: 'failed', attempts: 5 },
      { id: 'b', state: 'failed', attempts: 5 },
      { id: 'c', state: 'uploaded', attempts: 1 },
    ]);
    // Reopening runs the recovery against the rows now present.
    db.prepare(`DELETE FROM capture_meta`).run();
    openStore(db);

    const pending = db.prepare(`SELECT id, attempts FROM screenshots WHERE upload_state='pending' ORDER BY id`).all();
    expect(pending).toEqual([{ id: 'a', attempts: 0 }, { id: 'b', attempts: 0 }]);
    // An already-uploaded shot is left alone.
    expect(db.prepare(`SELECT upload_state FROM screenshots WHERE id='c'`).get()).toEqual({ upload_state: 'uploaded' });
  });

  it('does not resurrect dead rows on every launch', () => {
    const db = new Database(':memory:');
    openStore(db);
    db.prepare(`DELETE FROM capture_meta`).run();
    seed(db, [{ id: 'a', state: 'failed', attempts: 5 }]);
    openStore(db); // recovery runs, marker written

    // The shot fails again for a reason of its own.
    db.prepare(`UPDATE screenshots SET upload_state='failed', attempts=5 WHERE id='a'`).run();
    openStore(db); // a later launch must leave it alone

    expect(db.prepare(`SELECT upload_state FROM screenshots WHERE id='a'`).get())
      .toEqual({ upload_state: 'failed' });
  });
});
