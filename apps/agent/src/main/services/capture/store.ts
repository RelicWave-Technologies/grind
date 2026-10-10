import type Database from 'better-sqlite3';

/**
 * Marker for the one-time requeue of shots written off while the server was
 * answering storage outages with a 500. Bump the suffix only to run another
 * one-off recovery — never to re-run this one.
 */
const RECOVER_STORAGE_OUTAGE = 'requeue:storage-outage-500';
/**
 * Before beta.38 a shot was written off after five failures of any kind — a
 * quarter hour offline, a server hiccup, or the server's `out_of_scope` 400 for
 * a shot whose timer entry it did not have yet. Those whose file is still on
 * disk deserve one more pass now that only a definitive refusal is terminal.
 */
export const RECOVER_FAILED_WITH_FILE = 'requeue:failed-with-file-v38';

export type UploadState = 'pending' | 'uploading' | 'uploaded' | 'failed';

/** The signed-in account a local row was captured for. */
export interface CaptureOwner {
  userId: string;
  workspaceId: string;
}

export interface ScreenshotRow {
  id: string;
  timeEntryId: string | null;
  displayId: string;
  capturedAt: number;
  /** Relative to the screenshots directory (older rows: absolute, migrated on open). */
  filePath: string;
  bytes: number;
  width: number;
  height: number;
  uploadState: UploadState;
  attempts: number;
  s3Key: string | null;
  lastError: string | null;
  nextAttemptAt: number | null;
  failedAt: number | null;
  /** Who captured it. Rows from before owner scoping are null until claimed. */
  ownerUserId?: string | null;
  ownerWorkspaceId?: string | null;
  uploadedAt?: number | null;
  /** When the full-size local file was swapped for a small thumbnail. */
  localTrimmedAt?: number | null;
}

/**
 * The path below the screenshots directory, for a path stored by an older
 * agent as absolute (`<userData>/screenshots/2026-10-05/<id>.webp`).
 *
 * Absolute paths broke whenever userData moved — a rename of the app, a
 * migrated profile — and every row then read as a missing file. Returns null
 * for a path that is already relative or does not sit under a screenshots dir.
 */
export function relativeScreenshotPath(stored: string): string | null {
  const isAbsolute = stored.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(stored) || stored.startsWith('\\\\');
  if (!isAbsolute) return null;
  const match = /^.*[\\/]screenshots[\\/](.+)$/u.exec(stored);
  return match?.[1] ?? null;
}

/** Local screenshot queue (better-sqlite3). Files live on disk under the screenshots dir; rows point to them. */
export class ScreenshotStore {
  constructor(private readonly db: Database.Database) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS screenshots (
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
        s3_key       TEXT,
        last_error   TEXT,
        next_attempt_at INTEGER,
        failed_at    INTEGER
      );
    `);
    for (const col of [
      'last_error TEXT',
      'next_attempt_at INTEGER',
      'failed_at INTEGER',
      'owner_user_id TEXT',
      'owner_workspace_id TEXT',
      'uploaded_at INTEGER',
      'local_trimmed_at INTEGER',
    ]) {
      try {
        this.db.exec(`ALTER TABLE screenshots ADD COLUMN ${col}`);
      } catch {
        /* already added on a prior boot */
      }
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_shots_captured ON screenshots(captured_at);
      CREATE TABLE IF NOT EXISTS capture_meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_shots_upload ON screenshots(upload_state);
      CREATE INDEX IF NOT EXISTS idx_shots_next_attempt ON screenshots(upload_state, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_shots_owner ON screenshots(owner_user_id, owner_workspace_id, captured_at);
    `);
    this.migrateAbsolutePaths();
    // Crash recovery: any 'uploading' left mid-flight goes back to 'pending'.
    this.db
      .prepare(`UPDATE screenshots SET upload_state='pending', next_attempt_at=NULL WHERE upload_state='uploading'`)
      .run();
    this.requeueOnce(RECOVER_STORAGE_OUTAGE);
  }

  /**
   * One-time requeue of written-off shots whose local file still exists (see
   * {@link RECOVER_FAILED_WITH_FILE}). A shot without its file can never upload,
   * so it stays failed. `fileExists` is injected so the store needs no fs.
   * Returns how many were requeued (0 once the marker is set).
   */
  requeueFailedWithFileOnce(fileExists: (filePath: string) => boolean): number {
    if (this.db.prepare(`SELECT 1 FROM capture_meta WHERE key = ?`).get(RECOVER_FAILED_WITH_FILE)) return 0;
    const failed = this.db
      .prepare(`SELECT id, file_path FROM screenshots WHERE upload_state='failed'`)
      .all() as { id: string; file_path: string }[];
    const withFile = failed.filter((r) => {
      try {
        return fileExists(String(r.file_path));
      } catch {
        return false;
      }
    });
    const requeue = this.db.prepare(
      `UPDATE screenshots
       SET upload_state='pending', attempts=0, next_attempt_at=NULL, failed_at=NULL, last_error=NULL
       WHERE id = ? AND upload_state='failed'`,
    );
    return this.db.transaction(() => {
      for (const r of withFile) requeue.run(r.id);
      this.db.prepare(`INSERT OR REPLACE INTO capture_meta (key, value) VALUES (?, ?)`)
        .run(RECOVER_FAILED_WITH_FILE, String(withFile.length));
      return withFile.length;
    })();
  }

  /**
   * Put every terminally-failed shot back in the queue, once.
   *
   * The server used to answer a storage outage with a 500, which the uploader
   * counts against a shot's five attempts. A full Google shared drive
   * therefore wrote off tens of thousands of screenshots that were never the
   * agent's fault, and nothing ever looked at them again — `pending()` only
   * ever selects `upload_state='pending'`.
   *
   * The API now answers 503 for storage failures, which costs no attempt, so
   * the shots written off under the old behaviour deserve one more pass.
   *
   * Guarded by a marker rather than run on every start: a permanent
   * retry-everything would resurrect genuinely dead rows — a deleted local
   * file, a shot the server rejected — on every launch, forever. A row whose
   * file is really gone fails once on ENOENT, which is terminal, and settles
   * straight back to failed.
   *
   * The count lands in `capture_meta` alongside the marker, so how many were
   * recovered is answerable later without this module needing a logger — and
   * without a logger it stays testable outside Electron.
   */
  private requeueOnce(marker: string): void {
    const done = this.db
      .prepare(`SELECT 1 FROM capture_meta WHERE key = ?`)
      .get(marker) as unknown;
    if (done) return;

    const requeue = this.db.transaction(() => {
      const { changes } = this.db
        .prepare(
          `UPDATE screenshots
           SET upload_state='pending', attempts=0, next_attempt_at=NULL,
               failed_at=NULL, last_error=NULL
           WHERE upload_state='failed'`,
        )
        .run();
      this.db.prepare(`INSERT OR REPLACE INTO capture_meta (key, value) VALUES (?, ?)`)
        .run(marker, String(changes));
      return changes;
    });
    requeue();
  }

  /**
   * Rewrite absolute file paths left by older agents as paths relative to the
   * screenshots directory. Idempotent: relative rows are never selected again.
   */
  private migrateAbsolutePaths(): void {
    const rows = this.db
      .prepare(`SELECT id, file_path FROM screenshots WHERE file_path LIKE '/%' OR file_path LIKE '_:%' OR file_path LIKE '\\%'`)
      .all() as { id: string; file_path: string }[];
    if (rows.length === 0) return;
    const update = this.db.prepare(`UPDATE screenshots SET file_path = ? WHERE id = ?`);
    this.db.transaction(() => {
      for (const row of rows) {
        const relative = relativeScreenshotPath(row.file_path);
        if (relative) update.run(relative, row.id);
      }
    })();
  }

  insert(row: ScreenshotRow): void {
    this.db
      .prepare(
        `INSERT INTO screenshots
          (id, time_entry_id, display_id, captured_at, file_path, bytes, width, height,
           upload_state, attempts, s3_key, last_error, next_attempt_at, failed_at,
           owner_user_id, owner_workspace_id)
         VALUES (@id, @timeEntryId, @displayId, @capturedAt, @filePath, @bytes, @width, @height,
           @uploadState, @attempts, @s3Key, @lastError, @nextAttemptAt, @failedAt,
           @ownerUserId, @ownerWorkspaceId)`,
      )
      .run({ ...row, ownerUserId: row.ownerUserId ?? null, ownerWorkspaceId: row.ownerWorkspaceId ?? null });
  }

  /**
   * Claim rows captured before owner scoping for the account whose timer
   * entries they belong to. A row is claimed only through an entry the timer
   * store has already proven is this owner's — so a shot taken under one
   * account is never uploaded under another. Rows of an unproven entry wait.
   */
  claimUnowned(owner: CaptureOwner): number {
    if (!this.hasLocalEntries()) return 0;
    const info = this.db
      .prepare(
        `UPDATE screenshots
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

  /** The owner's shots captured in [from, to), newest first. */
  inRange(owner: CaptureOwner, fromMs: number, toMs: number): ScreenshotRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM screenshots
         WHERE owner_user_id = ? AND owner_workspace_id = ? AND captured_at >= ? AND captured_at < ?
         ORDER BY captured_at DESC, id DESC`,
      )
      .all(owner.userId, owner.workspaceId, fromMs, toMs) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  /** When the same display was last captured before `beforeMs` (for per-shot activity windows). */
  previousCaptureOnDisplay(owner: CaptureOwner, displayId: string, beforeMs: number): number | null {
    const r = this.db
      .prepare(
        `SELECT MAX(captured_at) AS t FROM screenshots
         WHERE owner_user_id = ? AND owner_workspace_id = ? AND display_id = ? AND captured_at < ?`,
      )
      .get(owner.userId, owner.workspaceId, displayId, beforeMs) as { t: number | null } | undefined;
    return r?.t ?? null;
  }

  find(id: string): ScreenshotRow | null {
    const r = this.db.prepare(`SELECT * FROM screenshots WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? mapRow(r) : null;
  }

  /**
   * The owner's next shots to upload, oldest first. A shot goes up with its
   * timer entry id whether or not that entry has reached the server yet: the
   * server keeps it unlinked and links it when the entry arrives.
   */
  pending(
    owner: CaptureOwner,
    limit: number,
// eslint-disable-next-line no-restricted-syntax -- device<->device: compared against nextAttemptAt, written by this same store
now = Date.now(),
  ): ScreenshotRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM screenshots
         WHERE upload_state='pending' AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
           AND owner_user_id = @userId AND owner_workspace_id = @workspaceId
         ORDER BY captured_at ASC LIMIT @limit`,
      )
      .all({ now, limit, userId: owner.userId, workspaceId: owner.workspaceId }) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  /**
   * Take a pending row for upload. Atomic: of two passes racing for the same
   * shot only one sees `changes = 1`, so a shot is never uploaded twice.
   */
  claimForUpload(id: string): boolean {
    const info = this.db
      .prepare(`UPDATE screenshots SET upload_state='uploading', next_attempt_at=NULL WHERE id = ? AND upload_state='pending'`)
      .run(id);
    return Number(info.changes ?? 0) === 1;
  }

  /** Mark a row uploaded and record the storage key the server returned. */
// eslint-disable-next-line no-restricted-syntax -- device<->device: local bookkeeping for the local-file trim, never sent
markUploaded(id: string, key: string, uploadedAt = Date.now()): void {
    this.db
      .prepare(
        `UPDATE screenshots
         SET upload_state='uploaded',
             s3_key=@key,
             uploaded_at=@uploadedAt,
             last_error=NULL,
             next_attempt_at=NULL,
             failed_at=NULL
         WHERE id=@id`,
      )
      .run({ id, key, uploadedAt });
  }

  /** Uploaded shots whose full-size local file is older than `beforeMs` and not yet trimmed. */
  uploadedToTrim(beforeMs: number, limit: number): ScreenshotRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM screenshots
         WHERE upload_state='uploaded' AND local_trimmed_at IS NULL
           AND COALESCE(uploaded_at, captured_at) < ?
         ORDER BY captured_at ASC LIMIT ?`,
      )
      .all(beforeMs, limit) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  markTrimmed(id: string, bytes: number, at: number): void {
    this.db.prepare(`UPDATE screenshots SET local_trimmed_at = ?, bytes = ? WHERE id = ?`).run(at, bytes, id);
  }

  /** Return a row to pending without consuming an attempt (auth/storage unavailable). */
  markPending(id: string, lastError: string | null = null, nextAttemptAt: number | null = null): void {
    this.db
      .prepare(
        `UPDATE screenshots
         SET upload_state='pending',
             last_error=@lastError,
             next_attempt_at=@nextAttemptAt,
             failed_at=NULL
         WHERE id=@id`,
      )
      .run({ id, lastError, nextAttemptAt });
  }

  /** Schedule a retryable failure with backoff and a consumed attempt. */
  markRetryScheduled(id: string, lastError: string, nextAttemptAt: number): void {
    this.db
      .prepare(
        `UPDATE screenshots
         SET upload_state='pending',
             attempts=attempts+1,
             last_error=@lastError,
             next_attempt_at=@nextAttemptAt,
             failed_at=NULL
         WHERE id=@id`,
      )
      .run({ id, lastError, nextAttemptAt });
  }

  /** Mark a row terminally failed after a hard error or retry cap. */
// eslint-disable-next-line no-restricted-syntax -- device<->device: local failure bookkeeping, never sent
markTerminalFailed(id: string, lastError: string, failedAt = Date.now()): void {
    this.db
      .prepare(
        `UPDATE screenshots
         SET upload_state='failed',
             attempts=attempts+1,
             last_error=@lastError,
             next_attempt_at=NULL,
             failed_at=@failedAt
         WHERE id=@id`,
      )
      .run({ id, lastError, failedAt });
  }

  /**
   * A developer-requested resend of the owner's shots in [fromMs, toMs):
   * anything pending or written off goes back on the queue with a clean
   * slate. Uploaded shots are only counted — their local copy may already be
   * trimmed to a thumbnail, so they are never sent again.
   */
  requeueRange(owner: CaptureOwner, fromMs: number, toMs: number): { requeued: number; uploaded: number } {
    const requeue = this.db.transaction(() => {
      const { changes } = this.db
        .prepare(
          `UPDATE screenshots
           SET upload_state='pending', attempts=0, next_attempt_at=NULL, failed_at=NULL, last_error=NULL
           WHERE owner_user_id = ? AND owner_workspace_id = ? AND captured_at >= ? AND captured_at < ?
             AND upload_state IN ('pending', 'failed')`,
        )
        .run(owner.userId, owner.workspaceId, fromMs, toMs);
      return Number(changes ?? 0);
    });
    const requeued = requeue();
    return { requeued, uploaded: this.rangeSummary(owner, fromMs, toMs).uploaded };
  }

  /** The owner's shots in [fromMs, toMs) by upload state (uploading counts as pending). */
  rangeSummary(owner: CaptureOwner, fromMs: number, toMs: number): { pending: number; uploaded: number; failed: number } {
    const rows = this.db
      .prepare(
        `SELECT upload_state AS state, COUNT(*) AS n FROM screenshots
         WHERE owner_user_id = ? AND owner_workspace_id = ? AND captured_at >= ? AND captured_at < ?
         GROUP BY upload_state`,
      )
      .all(owner.userId, owner.workspaceId, fromMs, toMs) as { state: string; n: number }[];
    const out = { pending: 0, uploaded: 0, failed: 0 };
    for (const row of rows) {
      if (row.state === 'pending' || row.state === 'uploading') out.pending += Number(row.n);
      else if (row.state === 'uploaded') out.uploaded += Number(row.n);
      else if (row.state === 'failed') out.failed += Number(row.n);
    }
    return out;
  }

  /** Minimal projection of every row, for the retention planner. */
  allForRetention(): { id: string; filePath: string; capturedAt: number; uploadState: UploadState }[] {
    const rows = this.db
      .prepare(`SELECT id, file_path, captured_at, upload_state FROM screenshots`)
      .all() as { id: string; file_path: string; captured_at: number; upload_state: string }[];
    return rows.map((r) => ({
      id: String(r.id),
      filePath: String(r.file_path),
      capturedAt: Number(r.captured_at),
      uploadState: String(r.upload_state) as UploadState,
    }));
  }

  /** Delete rows by id (retention / reconciliation). */
  deleteByIds(ids: string[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(`DELETE FROM screenshots WHERE id = ?`);
    const tx = this.db.transaction((list: string[]) => list.forEach((id) => stmt.run(id)));
    tx(ids);
  }
}

function mapRow(r: Record<string, unknown>): ScreenshotRow {
  return {
    id: String(r.id),
    timeEntryId: r.time_entry_id === null ? null : String(r.time_entry_id),
    displayId: String(r.display_id),
    capturedAt: Number(r.captured_at),
    filePath: String(r.file_path),
    bytes: Number(r.bytes),
    width: Number(r.width),
    height: Number(r.height),
    uploadState: String(r.upload_state) as UploadState,
    attempts: Number(r.attempts),
    s3Key: r.s3_key === null ? null : String(r.s3_key),
    lastError: r.last_error === null || r.last_error === undefined ? null : String(r.last_error),
    nextAttemptAt: r.next_attempt_at === null || r.next_attempt_at === undefined ? null : Number(r.next_attempt_at),
    failedAt: r.failed_at === null || r.failed_at === undefined ? null : Number(r.failed_at),
    ownerUserId: r.owner_user_id == null ? null : String(r.owner_user_id),
    ownerWorkspaceId: r.owner_workspace_id == null ? null : String(r.owner_workspace_id),
    uploadedAt: r.uploaded_at == null ? null : Number(r.uploaded_at),
    localTrimmedAt: r.local_trimmed_at == null ? null : Number(r.local_trimmed_at),
  };
}
