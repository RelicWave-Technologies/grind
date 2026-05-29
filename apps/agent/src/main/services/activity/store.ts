import type Database from 'better-sqlite3';

export interface ActivityRow {
  id: string;
  timeEntryId: string | null;
  bucketStart: number;
  keystrokes: number;
  clicks: number;
  mouseDistancePx: number;
  scrollEvents: number;
  ikiCv: number | null;
  moveSpeedCv: number | null;
  pathStraightness: number | null;
  synced: number;
}

/** Local per-minute activity sample queue (better-sqlite3). Counts + content-free CVs only. */
export class ActivityStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS activity_samples (
        id            TEXT PRIMARY KEY,
        time_entry_id TEXT,
        bucket_start  INTEGER NOT NULL,
        keystrokes    INTEGER NOT NULL,
        clicks        INTEGER NOT NULL,
        mouse_dist_px INTEGER NOT NULL,
        scroll_events INTEGER NOT NULL,
        iki_cv        REAL,
        move_speed_cv REAL,
        path_straight REAL,
        synced        INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_activity_bucket ON activity_samples(bucket_start);
      CREATE INDEX IF NOT EXISTS idx_activity_synced ON activity_samples(synced);
    `);
  }

  insert(r: ActivityRow): void {
    this.db
      .prepare(
        `INSERT INTO activity_samples
          (id, time_entry_id, bucket_start, keystrokes, clicks, mouse_dist_px, scroll_events, iki_cv, move_speed_cv, path_straight, synced)
         VALUES (@id, @timeEntryId, @bucketStart, @keystrokes, @clicks, @mouseDistancePx, @scrollEvents, @ikiCv, @moveSpeedCv, @pathStraightness, 0)`,
      )
      .run(r);
  }

  unsynced(limit: number): ActivityRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM activity_samples WHERE synced = 0 ORDER BY bucket_start ASC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map(map);
  }

  markSynced(ids: string[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(`UPDATE activity_samples SET synced = 1 WHERE id = ?`);
    const tx = this.db.transaction((list: string[]) => list.forEach((id) => stmt.run(id)));
    tx(ids);
  }

  countSince(sinceMs: number): { keystrokes: number; clicks: number; scrollEvents: number } {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(keystrokes),0) k, COALESCE(SUM(clicks),0) c, COALESCE(SUM(scroll_events),0) s
         FROM activity_samples WHERE bucket_start >= ?`,
      )
      .get(sinceMs) as { k: number; c: number; s: number };
    return { keystrokes: r.k, clicks: r.c, scrollEvents: r.s };
  }
}

function map(r: Record<string, unknown>): ActivityRow {
  return {
    id: String(r.id),
    timeEntryId: r.time_entry_id === null ? null : String(r.time_entry_id),
    bucketStart: Number(r.bucket_start),
    keystrokes: Number(r.keystrokes),
    clicks: Number(r.clicks),
    mouseDistancePx: Number(r.mouse_dist_px),
    scrollEvents: Number(r.scroll_events),
    ikiCv: r.iki_cv === null ? null : Number(r.iki_cv),
    moveSpeedCv: r.move_speed_cv === null ? null : Number(r.move_speed_cv),
    pathStraightness: r.path_straight === null ? null : Number(r.path_straight),
    synced: Number(r.synced),
  };
}
