import type Database from 'better-sqlite3';

export type UploadState = 'pending' | 'uploading' | 'uploaded' | 'failed';

export interface ScreenshotRow {
  id: string;
  timeEntryId: string | null;
  displayId: string;
  capturedAt: number;
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
}

export interface ScreenshotUploadSummary {
  pending: number;
  uploading: number;
  failed: number;
}

/** Local screenshot queue (better-sqlite3). Files live on disk; rows point to them. */
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
      CREATE INDEX IF NOT EXISTS idx_shots_captured ON screenshots(captured_at);
      CREATE INDEX IF NOT EXISTS idx_shots_upload ON screenshots(upload_state);
      CREATE INDEX IF NOT EXISTS idx_shots_next_attempt ON screenshots(upload_state, next_attempt_at);
    `);
    for (const col of ['last_error TEXT', 'next_attempt_at INTEGER', 'failed_at INTEGER']) {
      try {
        this.db.exec(`ALTER TABLE screenshots ADD COLUMN ${col}`);
      } catch {
        /* already added on a prior boot */
      }
    }
    // Crash recovery: any 'uploading' left mid-flight goes back to 'pending'.
    this.db
      .prepare(`UPDATE screenshots SET upload_state='pending', next_attempt_at=NULL WHERE upload_state='uploading'`)
      .run();
    // Older agents left capped rows as forever-pending. Make the cap visible.
    this.db
      .prepare(
        `UPDATE screenshots
         SET upload_state='failed',
             failed_at=COALESCE(failed_at, ?),
             next_attempt_at=NULL,
             last_error=COALESCE(last_error, 'retry limit reached')
         WHERE upload_state='pending' AND attempts >= 5`,
      )
      .run(Date.now());
  }

  insert(row: ScreenshotRow): void {
    this.db
      .prepare(
        `INSERT INTO screenshots
          (id, time_entry_id, display_id, captured_at, file_path, bytes, width, height,
           upload_state, attempts, s3_key, last_error, next_attempt_at, failed_at)
         VALUES (@id, @timeEntryId, @displayId, @capturedAt, @filePath, @bytes, @width, @height,
           @uploadState, @attempts, @s3Key, @lastError, @nextAttemptAt, @failedAt)`,
      )
      .run(row);
  }

  recent(limit: number): ScreenshotRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM screenshots ORDER BY captured_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  find(id: string): ScreenshotRow | null {
    const r = this.db.prepare(`SELECT * FROM screenshots WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return r ? mapRow(r) : null;
  }

  countSince(sinceMs: number): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM screenshots WHERE captured_at >= ?`)
      .get(sinceMs) as { n: number };
    return r.n;
  }

  pending(limit: number, now = Date.now()): ScreenshotRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM screenshots
         WHERE upload_state='pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY captured_at ASC LIMIT ?`,
      )
      .all(now, limit) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  /** Mark a row as actively uploading (so a concurrent drain skips it). */
  markUploading(id: string): void {
    this.db.prepare(`UPDATE screenshots SET upload_state='uploading', next_attempt_at=NULL WHERE id = ?`).run(id);
  }

  /** Mark a row uploaded and record the Cloudinary public_id as the key. */
  markUploaded(id: string, key: string): void {
    this.db
      .prepare(
        `UPDATE screenshots
         SET upload_state='uploaded',
             s3_key=@key,
             last_error=NULL,
             next_attempt_at=NULL,
             failed_at=NULL
         WHERE id=@id`,
      )
      .run({ id, key });
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

  resetFailedUploads(): number {
    const info = this.db
      .prepare(
        `UPDATE screenshots
         SET upload_state='pending',
             attempts=0,
             last_error=NULL,
             next_attempt_at=NULL,
             failed_at=NULL
         WHERE upload_state='failed'`,
      )
      .run();
    return Number(info.changes ?? 0);
  }

  uploadSummary(): ScreenshotUploadSummary {
    const out: ScreenshotUploadSummary = { pending: 0, uploading: 0, failed: 0 };
    const rows = this.db
      .prepare(`SELECT upload_state AS state, COUNT(*) AS n FROM screenshots GROUP BY upload_state`)
      .all() as { state: string; n: number }[];
    for (const row of rows) {
      if (row.state === 'pending' || row.state === 'uploading' || row.state === 'failed') {
        out[row.state] = Number(row.n);
      }
    }
    return out;
  }

  /** Minimal projection of every row, for the retention planner. */
  allForRetention(): { id: string; filePath: string; capturedAt: number }[] {
    const rows = this.db
      .prepare(`SELECT id, file_path, captured_at FROM screenshots`)
      .all() as { id: string; file_path: string; captured_at: number }[];
    return rows.map((r) => ({ id: String(r.id), filePath: String(r.file_path), capturedAt: Number(r.captured_at) }));
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
  };
}
