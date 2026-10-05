import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { ScreenshotStore, relativeScreenshotPath, type ScreenshotRow } from './store';

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

  it('gives shots written off by the old five-attempt cap one more pass after upgrading', () => {
    const db = new Database(':memory:');
    openStore(db);
    // An agent that already ran the storage-outage recovery, then lost shots
    // to the attempt cap while offline.
    db.prepare(`DELETE FROM capture_meta WHERE key = 'requeue:attempt-cap-v38'`).run();
    seed(db, [{ id: 'offline', state: 'failed', attempts: 5 }]);
    openStore(db);

    expect(db.prepare(`SELECT upload_state, attempts FROM screenshots WHERE id='offline'`).get())
      .toEqual({ upload_state: 'pending', attempts: 0 });
  });
});


describe('ScreenshotStore upload queue', () => {
  const OWNER = { userId: 'u1', workspaceId: 'w1' };
  const OTHER = { userId: 'u2', workspaceId: 'w1' };

  const shot = (id: string, over: Partial<ScreenshotRow> = {}): ScreenshotRow => ({
    id,
    timeEntryId: null,
    displayId: 'd1',
    capturedAt: 1_000,
    filePath: `2026-10-05/${id}.webp`,
    bytes: 1,
    width: 1,
    height: 1,
    uploadState: 'pending',
    attempts: 0,
    s3Key: null,
    lastError: null,
    nextAttemptAt: null,
    failedAt: null,
    ownerUserId: OWNER.userId,
    ownerWorkspaceId: OWNER.workspaceId,
    ...over,
  });

  /** The timer's table, as the timer store creates it in the same agent.db. */
  const withLocalEntries = (db: InstanceType<typeof Database>) => {
    db.exec(`CREATE TABLE local_entries (
      id TEXT PRIMARY KEY, sync_state TEXT NOT NULL, owner_user_id TEXT, owner_workspace_id TEXT
    )`);
    return db;
  };

  it('claims a shot for upload exactly once', () => {
    const store = new ScreenshotStore(new Database(':memory:'));
    store.insert(shot('a'));
    expect(store.claimForUpload('a')).toBe(true);
    // A second pass racing for the same shot is refused.
    expect(store.claimForUpload('a')).toBe(false);
    expect(store.find('a')?.uploadState).toBe('uploading');
  });

  it('puts a shot left mid-upload by a crash back in the queue on open', () => {
    const db = new Database(':memory:');
    const store = new ScreenshotStore(db);
    store.insert(shot('a'));
    store.claimForUpload('a');
    expect(new ScreenshotStore(db).find('a')?.uploadState).toBe('pending');
  });

  it('keeps retrying shots past five attempts across restarts', () => {
    const db = new Database(':memory:');
    new ScreenshotStore(db).insert(shot('a', { attempts: 9 }));
    expect(new ScreenshotStore(db).find('a')?.uploadState).toBe('pending');
  });

  it('queues and lists only the signed-in account\'s shots', () => {
    const store = new ScreenshotStore(new Database(':memory:'));
    store.insert(shot('mine'));
    store.insert(shot('theirs', { ownerUserId: OTHER.userId, ownerWorkspaceId: OTHER.workspaceId }));
    store.insert(shot('legacy', { ownerUserId: null, ownerWorkspaceId: null }));

    expect(store.pending(OWNER, 10, 2_000).map((r) => r.id)).toEqual(['mine']);
    expect(store.recent(OWNER, 10).map((r) => r.id)).toEqual(['mine']);
    expect(store.inRange(OTHER, 0, 2_000).map((r) => r.id)).toEqual(['theirs']);
    expect(store.uploadSummary(OWNER)).toEqual({ pending: 1, uploading: 0, failed: 0 });
    expect(store.uploadSummary(null)).toEqual({ pending: 0, uploading: 0, failed: 0 });
  });

  it('claims legacy shots only through timer entries proven to be the owner\'s', () => {
    const db = withLocalEntries(new Database(':memory:'));
    db.prepare(`INSERT INTO local_entries VALUES ('e-mine', 'synced', 'u1', 'w1'), ('e-theirs', 'synced', 'u2', 'w1')`).run();
    const store = new ScreenshotStore(db);
    store.insert(shot('a', { ownerUserId: null, ownerWorkspaceId: null, timeEntryId: 'e-mine' }));
    store.insert(shot('b', { ownerUserId: null, ownerWorkspaceId: null, timeEntryId: 'e-theirs' }));
    store.insert(shot('c', { ownerUserId: null, ownerWorkspaceId: null, timeEntryId: null }));

    expect(store.claimUnowned(OWNER)).toBe(1);
    expect(store.find('a')?.ownerUserId).toBe('u1');
    expect(store.find('b')?.ownerUserId).toBeNull();
    expect(store.find('c')?.ownerUserId).toBeNull();
  });

  it('holds a shot whose entry is still being created for an hour, without stalling the rest', () => {
    const db = withLocalEntries(new Database(':memory:'));
    db.prepare(`INSERT INTO local_entries VALUES ('e-new', 'pending_create', 'u1', 'w1'), ('e-ok', 'synced', 'u1', 'w1')`).run();
    const store = new ScreenshotStore(db);
    const HOUR = 60 * 60_000;
    const now = 10 * HOUR;
    // Five held shots ahead of a ready one: the batch must still reach it.
    for (let i = 0; i < 5; i++) store.insert(shot(`held-${i}`, { timeEntryId: 'e-new', capturedAt: now - 10 * 60_000 + i }));
    store.insert(shot('ready', { timeEntryId: 'e-ok', capturedAt: now - 60_000 }));
    store.insert(shot('stale', { timeEntryId: 'e-new', capturedAt: now - 2 * HOUR }));
    store.insert(shot('no-entry', { capturedAt: now - 30_000 }));

    expect(store.pending(OWNER, 5, now).map((r) => r.id)).toEqual(['stale', 'ready', 'no-entry']);
  });

  it('rewrites absolute file paths as relative to the screenshots dir', () => {
    const db = new Database(':memory:');
    new ScreenshotStore(db);
    const insert = db.prepare(
      `INSERT INTO screenshots (id, display_id, captured_at, file_path, bytes, width, height) VALUES (?, 'd', 1, ?, 1, 1, 1)`,
    );
    insert.run('mac', '/Users/me/Library/Application Support/Grind/screenshots/2026-10-01/mac.webp');
    insert.run('win', 'C:\\Users\\me\\AppData\\Roaming\\Timo\\screenshots\\2026-10-01\\win.webp');
    insert.run('rel', '2026-10-01/rel.webp');
    insert.run('odd', '/somewhere/else/odd.webp');

    const store = new ScreenshotStore(db);
    expect(store.find('mac')?.filePath).toBe('2026-10-01/mac.webp');
    expect(store.find('win')?.filePath).toBe('2026-10-01\\win.webp');
    expect(store.find('rel')?.filePath).toBe('2026-10-01/rel.webp');
    expect(store.find('odd')?.filePath).toBe('/somewhere/else/odd.webp');
  });

  it('offers uploaded shots for a local trim only after they have been on the server a while', () => {
    const store = new ScreenshotStore(new Database(':memory:'));
    store.insert(shot('old'));
    store.insert(shot('fresh'));
    store.insert(shot('waiting'));
    store.markUploaded('old', 'k1', 1_000);
    store.markUploaded('fresh', 'k2', 9_000);

    expect(store.uploadedToTrim(5_000, 10).map((r) => r.id)).toEqual(['old']);
    store.markTrimmed('old', 10, 6_000);
    expect(store.uploadedToTrim(10_000, 10).map((r) => r.id)).toEqual(['fresh']);
    expect(store.find('old')).toMatchObject({ localTrimmedAt: 6_000, bytes: 10, uploadState: 'uploaded' });
  });
});

describe('relativeScreenshotPath', () => {
  it('keeps everything below the last screenshots folder', () => {
    expect(relativeScreenshotPath('/home/screenshots/x/Grind/screenshots/2026-10-01/a.webp')).toBe('2026-10-01/a.webp');
    expect(relativeScreenshotPath('2026-10-01/a.webp')).toBeNull();
  });
});
