import type Database from 'better-sqlite3';
import type { PolicyFlags } from '@grind/types';

/** The signed-in account a local sample was recorded for. */
export interface ActivityOwner {
  userId: string;
  workspaceId: string;
}

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
  /** Who recorded it. Rows from before owner scoping are null until claimed. */
  ownerUserId?: string | null;
  ownerWorkspaceId?: string | null;
}

export interface ActivityWindowTotals {
  /** Stored minutes in the window — zero-activity tracked minutes included. */
  minutes: number;
  keystrokes: number;
  clicks: number;
  mouseDistancePx: number;
  scrollEvents: number;
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
      'owner_user_id TEXT',
      'owner_workspace_id TEXT',
    ]) {
      try {
        this.db.exec(`ALTER TABLE activity_samples ADD COLUMN ${col}`);
      } catch {
        /* already added on a prior boot */
      }
    }
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_activity_owner ON activity_samples(owner_user_id, owner_workspace_id, bucket_start)`,
    );
  }

  insert(r: ActivityRow): void {
    this.db
      .prepare(
        `INSERT INTO activity_samples
          (id, time_entry_id, bucket_start, keystrokes, clicks, mouse_dist_px, scroll_events,
           iki_cv, move_speed_cv, path_straight,
           active_app, active_app_bundle, active_title, active_url, synced,
           owner_user_id, owner_workspace_id)
         VALUES (@id, @timeEntryId, @bucketStart, @keystrokes, @clicks, @mouseDistancePx, @scrollEvents,
           @ikiCv, @moveSpeedCv, @pathStraightness,
           @activeApp, @activeAppBundle, @activeTitle, @activeUrl, 0,
           @ownerUserId, @ownerWorkspaceId)`,
      )
      .run({ ...r, ownerUserId: r.ownerUserId ?? null, ownerWorkspaceId: r.ownerWorkspaceId ?? null });
  }

  /**
   * Store a sealed minute, ADDING it to the minute already stored for the same
   * owner — the tail of a minute sealed after a quit/restart, or after the
   * partial was sealed on the way out.
   *
   * The minute keeps one row and one id, and goes back on the upload queue
   * with its new total. The server keeps the larger of what it has and what
   * arrives, so a re-sent total is idempotent and a tail can never overwrite
   * the head of its minute. Returns true when anything was written.
   */
  persistMinute(r: ActivityRow): boolean {
    const merge = this.db.transaction((row: ActivityRow): boolean => {
      const existing = this.db
        .prepare(
          `SELECT * FROM activity_samples
           WHERE bucket_start = ? AND owner_user_id IS ? AND owner_workspace_id IS ?
           ORDER BY rowid DESC LIMIT 1`,
        )
        .get(row.bucketStart, row.ownerUserId ?? null, row.ownerWorkspaceId ?? null) as
        Record<string, unknown> | undefined;
      if (!existing) {
        this.insert(row);
        return true;
      }
      const prev = map(existing);
      const empty = row.keystrokes === 0 && row.clicks === 0 && row.mouseDistancePx === 0 && row.scrollEvents === 0;
      if (empty) return false; // a quiet tail adds nothing to a minute already stored
      // Timing CVs cannot be combined exactly; keep the ones measured over more input.
      const keysFromNew = row.keystrokes >= prev.keystrokes;
      const movesFromNew = row.mouseDistancePx >= prev.mouseDistancePx;
      this.db
        .prepare(
          `UPDATE activity_samples SET
             keystrokes = @keystrokes, clicks = @clicks, mouse_dist_px = @mouseDistancePx,
             scroll_events = @scrollEvents, iki_cv = @ikiCv, move_speed_cv = @moveSpeedCv,
             path_straight = @pathStraightness, time_entry_id = @timeEntryId,
             active_app = @activeApp, active_app_bundle = @activeAppBundle,
             active_title = @activeTitle, active_url = @activeUrl, synced = 0
           WHERE id = @id`,
        )
        .run({
          id: prev.id,
          keystrokes: prev.keystrokes + row.keystrokes,
          clicks: prev.clicks + row.clicks,
          mouseDistancePx: prev.mouseDistancePx + row.mouseDistancePx,
          scrollEvents: prev.scrollEvents + row.scrollEvents,
          ikiCv: keysFromNew ? row.ikiCv ?? prev.ikiCv : prev.ikiCv ?? row.ikiCv,
          moveSpeedCv: movesFromNew ? row.moveSpeedCv ?? prev.moveSpeedCv : prev.moveSpeedCv ?? row.moveSpeedCv,
          pathStraightness: movesFromNew
            ? row.pathStraightness ?? prev.pathStraightness
            : prev.pathStraightness ?? row.pathStraightness,
          timeEntryId: prev.timeEntryId ?? row.timeEntryId,
          activeApp: prev.activeApp ?? row.activeApp,
          activeAppBundle: prev.activeAppBundle ?? row.activeAppBundle,
          activeTitle: prev.activeTitle ?? row.activeTitle,
          activeUrl: prev.activeUrl ?? row.activeUrl,
        });
      return true;
    });
    return merge(r);
  }

  /**
   * Claim samples recorded before owner scoping for the account whose timer
   * entries they belong to — only through entries the timer store has already
   * proven are this owner's, so one account's minutes never sync as another's.
   */
  claimUnowned(owner: ActivityOwner): number {
    if (!this.hasLocalEntries()) return 0;
    const info = this.db
      .prepare(
        `UPDATE activity_samples
         SET owner_user_id = @userId, owner_workspace_id = @workspaceId
         WHERE owner_user_id IS NULL AND time_entry_id IN (
           SELECT id FROM local_entries WHERE owner_user_id = @userId AND owner_workspace_id = @workspaceId
         )`,
      )
      .run({ userId: owner.userId, workspaceId: owner.workspaceId });
    return Number(info.changes ?? 0);
  }

  private hasLocalEntries(): boolean {
    return Boolean(
      this.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_entries'`).get(),
    );
  }

  /**
   * The owner's oldest unsynced samples whose timer entry the server already
   * has. Samples of an entry still waiting to be created are skipped HERE, in
   * SQL — filtering after the LIMIT let 500 waiting rows fill every batch and
   * stall the whole queue behind them.
   */
  unsynced(limit: number, owner: ActivityOwner): ActivityRow[] {
    const waitingForEntry = this.hasLocalEntries()
      ? `AND NOT EXISTS (
           SELECT 1 FROM local_entries le
           WHERE le.id = activity_samples.time_entry_id AND le.sync_state = 'pending_create')`
      : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM activity_samples
         WHERE synced = 0 AND owner_user_id = @userId AND owner_workspace_id = @workspaceId
           ${waitingForEntry}
         ORDER BY bucket_start ASC LIMIT @limit`,
      )
      .all({ limit, userId: owner.userId, workspaceId: owner.workspaceId }) as Record<string, unknown>[];
    return rows.map(map);
  }

  /**
   * Put the owner's minutes in [fromMs, toMs) back on the upload queue (a
   * developer-requested resend). Safe to repeat: the server keeps the larger
   * of what it has and what arrives. Returns how many minutes were queued.
   */
  markUnsyncedInRange(owner: ActivityOwner, fromMs: number, toMs: number): number {
    const info = this.db
      .prepare(
        `UPDATE activity_samples SET synced = 0
         WHERE owner_user_id = ? AND owner_workspace_id = ? AND bucket_start >= ? AND bucket_start < ?`,
      )
      .run(owner.userId, owner.workspaceId, fromMs, toMs);
    return Number(info.changes ?? 0);
  }

  /** The owner's minutes in [fromMs, toMs) still waiting to upload. */
  unsyncedInRange(owner: ActivityOwner, fromMs: number, toMs: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM activity_samples
         WHERE synced = 0 AND owner_user_id = ? AND owner_workspace_id = ? AND bucket_start >= ? AND bucket_start < ?`,
      )
      .get(owner.userId, owner.workspaceId, fromMs, toMs) as { n: number };
    return Number(row.n);
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

  countSince(sinceMs: number, owner: ActivityOwner): { keystrokes: number; clicks: number; scrollEvents: number } {
    const r = this.db
      .prepare(
        `SELECT COALESCE(SUM(keystrokes),0) k, COALESCE(SUM(clicks),0) c, COALESCE(SUM(scroll_events),0) s
         FROM activity_samples WHERE bucket_start >= ? AND owner_user_id = ? AND owner_workspace_id = ?`,
      )
      .get(sinceMs, owner.userId, owner.workspaceId) as { k: number; c: number; s: number };
    return { keystrokes: r.k, clicks: r.c, scrollEvents: r.s };
  }

  /**
   * The owner's summed counts + stored-minute count for a [from, to) window
   * (per-shot activity bars). One row per minute is the norm; a minute stored
   * twice by an older agent still counts once.
   */
  aggregate(fromMs: number, toMs: number, owner: ActivityOwner): ActivityWindowTotals {
    const r = this.db
      .prepare(
        `SELECT COUNT(DISTINCT bucket_start) n, COALESCE(SUM(keystrokes),0) k, COALESCE(SUM(clicks),0) c,
                COALESCE(SUM(mouse_dist_px),0) d, COALESCE(SUM(scroll_events),0) s
         FROM activity_samples
         WHERE bucket_start >= ? AND bucket_start < ? AND owner_user_id = ? AND owner_workspace_id = ?`,
      )
      .get(fromMs, toMs, owner.userId, owner.workspaceId) as { n: number; k: number; c: number; d: number; s: number };
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
    ownerUserId: r.owner_user_id == null ? null : String(r.owner_user_id),
    ownerWorkspaceId: r.owner_workspace_id == null ? null : String(r.owner_workspace_id),
  };
}
