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
