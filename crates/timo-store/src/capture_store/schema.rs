//! What the `ScreenshotStore` constructor does: schema, column migrations,
//! boot repairs and the one-time requeue.

use rusqlite::{Connection, OptionalExtension, Result, params};

/// Marker for the one-time requeue of shots written off while the server was
/// answering storage outages with a 500. Bump the suffix only to run another
/// one-off recovery, never to re-run this one.
const RECOVER_STORAGE_OUTAGE: &str = "requeue:storage-outage-500";

const CREATE_SCREENSHOTS: &str = "
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
    ";

/// Columns older databases lack; indexes over them must come after these.
const ADDED_COLUMNS: [&str; 3] = [
    "last_error TEXT",
    "next_attempt_at INTEGER",
    "failed_at INTEGER",
];

const CREATE_INDEXES: &str = "
      CREATE INDEX IF NOT EXISTS idx_shots_captured ON screenshots(captured_at);
      CREATE TABLE IF NOT EXISTS capture_meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_shots_upload ON screenshots(upload_state);
      CREATE INDEX IF NOT EXISTS idx_shots_next_attempt ON screenshots(upload_state, next_attempt_at);
    ";

/// Port of `legacy/agent/src/main/services/capture/store.ts::ScreenshotStore.constructor`.
/// `now_ms` is the TypeScript's `Date.now()` argument to the retry-cap repair, injected.
pub(super) fn init(conn: &mut Connection, now_ms: f64) -> Result<()> {
    conn.execute_batch(CREATE_SCREENSHOTS)?;
    for column in ADDED_COLUMNS {
        let sql = format!("ALTER TABLE screenshots ADD COLUMN {column}");
        if let Err(error) = conn.execute_batch(&sql) {
            tracing::debug!(%error, column, "screenshot column already added on a prior boot");
        }
    }
    conn.execute_batch(CREATE_INDEXES)?;
    // Crash recovery: any 'uploading' left mid-flight goes back to 'pending'.
    conn.execute(
        "UPDATE screenshots SET upload_state='pending', next_attempt_at=NULL WHERE upload_state='uploading'",
        [],
    )?;
    // Older agents left capped rows as forever-pending. Make the cap visible.
    conn.execute(
        "UPDATE screenshots
         SET upload_state='failed',
             failed_at=COALESCE(failed_at, ?),
             next_attempt_at=NULL,
             last_error=COALESCE(last_error, 'retry limit reached')
         WHERE upload_state='pending' AND attempts >= 5",
        [now_ms],
    )?;
    requeue_once(conn, RECOVER_STORAGE_OUTAGE)
}

/// Put every terminally-failed shot back in the queue, once. The count lands in
/// `capture_meta` beside the marker.
///
/// Guarded by a marker rather than run on every start: a permanent
/// retry-everything would resurrect genuinely dead rows (a deleted local file, a
/// shot the server rejected) on every launch, forever.
///
/// Port of `legacy/agent/src/main/services/capture/store.ts::ScreenshotStore.requeueOnce`.
fn requeue_once(conn: &mut Connection, marker: &str) -> Result<()> {
    let done: Option<i64> = conn
        .query_row("SELECT 1 FROM capture_meta WHERE key = ?", [marker], |r| {
            r.get(0)
        })
        .optional()?;
    if done.is_some() {
        return Ok(());
    }
    let tx = conn.transaction()?;
    let changes = tx.execute(
        "UPDATE screenshots
           SET upload_state='pending', attempts=0, next_attempt_at=NULL,
               failed_at=NULL, last_error=NULL
           WHERE upload_state='failed'",
        [],
    )?;
    tx.execute(
        "INSERT OR REPLACE INTO capture_meta (key, value) VALUES (?, ?)",
        params![marker, changes.to_string()],
    )?;
    tx.commit()
}
