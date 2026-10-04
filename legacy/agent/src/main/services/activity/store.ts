import type Database from 'better-sqlite3';
import type { PolicyFlags } from '@grind/types';

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
  // M14: dominant active window for the bucket. Server scrubs per policy.
  activeApp: string | null;
  activeAppBundle: string | null;
  activeTitle: string | null;
  activeUrl: string | null;
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
    // Idempotent column adds — SQLite has no `ADD COLUMN IF NOT EXISTS` so
    // we swallow "duplicate column" errors. This lets older agent installs
    // upgrade without losing their local queue.
    for (const col of [
      'active_app TEXT',
      'active_app_bundle TEXT',
      'active_title TEXT',
      'active_url TEXT',
    ]) {
      try {
        this.db.exec(`ALTER TABLE activity_samples ADD COLUMN ${col}`);
      } catch {
        /* already added on a prior boot */
      }
    }
  }

  insert(r: ActivityRow): void {
    this.db
      .prepare(
        `INSERT INTO activity_samples
          (id, time_entry_id, bucket_start, keystrokes, clicks, mouse_dist_px, scroll_events,
           iki_cv, move_speed_cv, path_straight,
           active_app, active_app_bundle, active_title, active_url, synced)
         VALUES (@id, @timeEntryId, @bucketStart, @keystrokes, @clicks, @mouseDistancePx, @scrollEvents,
           @ikiCv, @moveSpeedCv, @pathStraightness,
           @activeApp, @activeAppBundle, @activeTitle, @activeUrl, 0)`,
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

  scrubActiveFields(policy: PolicyFlags): number {
    const sets: string[] = [];
    if (!policy.captureApps) {
      sets.push('active_app = NULL', 'active_app_bundle = NULL', 'active_title = NULL', 'active_url = NULL');
    } else {
      if (!policy.captureTitles) sets.push('active_title = NULL');
      if (!policy.captureUrls) sets.push('active_url = NULL');
    }
    if (sets.length === 0) return 0;
    const info = this.db.prepare(`UPDATE activity_samples SET ${sets.join(', ')}`).run();
    return Number(info.changes ?? 0);
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

  /** Summed counts + minute count for a [from, to) window (for per-shot activity bars). */
  aggregate(fromMs: number, toMs: number): {
    minutes: number;
    keystrokes: number;
    clicks: number;
    mouseDistancePx: number;
    scrollEvents: number;
  } {
    const r = this.db
      .prepare(
        `SELECT COUNT(*) n, COALESCE(SUM(keystrokes),0) k, COALESCE(SUM(clicks),0) c,
                COALESCE(SUM(mouse_dist_px),0) d, COALESCE(SUM(scroll_events),0) s
         FROM activity_samples WHERE bucket_start >= ? AND bucket_start < ?`,
      )
      .get(fromMs, toMs) as { n: number; k: number; c: number; d: number; s: number };
    return { minutes: r.n, keystrokes: r.k, clicks: r.c, mouseDistancePx: r.d, scrollEvents: r.s };
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
    activeApp: r.active_app == null ? null : String(r.active_app),
    activeAppBundle: r.active_app_bundle == null ? null : String(r.active_app_bundle),
    activeTitle: r.active_title == null ? null : String(r.active_title),
    activeUrl: r.active_url == null ? null : String(r.active_url),
    synced: Number(r.synced),
  };
}
