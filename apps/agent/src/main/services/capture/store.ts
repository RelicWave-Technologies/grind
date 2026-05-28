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
        s3_key       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_shots_captured ON screenshots(captured_at);
      CREATE INDEX IF NOT EXISTS idx_shots_upload ON screenshots(upload_state);
    `);
    // Crash recovery: any 'uploading' left mid-flight goes back to 'pending'.
    this.db.prepare(`UPDATE screenshots SET upload_state='pending' WHERE upload_state='uploading'`).run();
  }

  insert(row: ScreenshotRow): void {
    this.db
      .prepare(
        `INSERT INTO screenshots
          (id, time_entry_id, display_id, captured_at, file_path, bytes, width, height, upload_state, attempts, s3_key)
         VALUES (@id, @timeEntryId, @displayId, @capturedAt, @filePath, @bytes, @width, @height, @uploadState, @attempts, @s3Key)`,
      )
      .run(row);
  }

  recent(limit: number): ScreenshotRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM screenshots ORDER BY captured_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map(mapRow);
  }

  countSince(sinceMs: number): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS n FROM screenshots WHERE captured_at >= ?`)
      .get(sinceMs) as { n: number };
    return r.n;
  }

  pending(limit: number): ScreenshotRow[] {
    const rows = this.db
      .prepare(`SELECT * FROM screenshots WHERE upload_state='pending' ORDER BY captured_at ASC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map(mapRow);
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
  };
}
