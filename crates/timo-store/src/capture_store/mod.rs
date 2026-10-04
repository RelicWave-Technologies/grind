//! Local screenshot queue. Files live on disk; rows point to them.
//!
//! Port of `legacy/agent/src/main/services/capture/store.ts`. As in the
//! TypeScript every timestamp is bound as a double: `captured_at` comes from the
//! fractional server-aligned clock and must stay fractional in the INTEGER
//! column, while `next_attempt_at` / `failed_at` (device `Date.now()`) are whole
//! and SQLite's affinity stores them as integers.

mod row;
mod schema;

use rusqlite::{Connection, OptionalExtension, Result, named_params};

use crate::row_value::{js_number, js_string, number_at, string_at};
use row::map_row;
pub use row::{
    FAILED, PENDING, RetentionRow, ScreenshotRow, ScreenshotUploadSummary, UPLOADED, UPLOADING,
};

/// Port of `ScreenshotStore`. Owns its connection, like the TypeScript's own `Database`.
#[derive(Debug)]
pub struct ScreenshotStore {
    conn: Connection,
}

impl ScreenshotStore {
    /// Port of `ScreenshotStore.constructor`. `now_ms` is its `Date.now()`.
    pub fn new(mut conn: Connection, now_ms: f64) -> Result<Self> {
        schema::init(&mut conn, now_ms)?;
        Ok(Self { conn })
    }

    /// The connection, for diagnostics and tests.
    #[must_use]
    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    /// Hands the connection back (a second store over the same database, as a reboot is).
    #[must_use]
    pub fn into_connection(self) -> Connection {
        self.conn
    }

    /// Port of `legacy/agent/src/main/services/capture/store.ts::ScreenshotStore.insert`.
    pub fn insert(&self, row: &ScreenshotRow) -> Result<()> {
        self.conn.execute(
            "INSERT INTO screenshots
          (id, time_entry_id, display_id, captured_at, file_path, bytes, width, height,
           upload_state, attempts, s3_key, last_error, next_attempt_at, failed_at)
         VALUES (@id, @timeEntryId, @displayId, @capturedAt, @filePath, @bytes, @width, @height,
           @uploadState, @attempts, @s3Key, @lastError, @nextAttemptAt, @failedAt)",
            named_params! {
                "@id": row.id,
                "@timeEntryId": row.time_entry_id,
                "@displayId": row.display_id,
                "@capturedAt": row.captured_at,
                "@filePath": row.file_path,
                "@bytes": row.bytes,
                "@width": row.width,
                "@height": row.height,
                "@uploadState": row.upload_state,
                "@attempts": row.attempts,
                "@s3Key": row.s3_key,
                "@lastError": row.last_error,
                "@nextAttemptAt": row.next_attempt_at,
                "@failedAt": row.failed_at,
            },
        )?;
        Ok(())
    }

    /// Port of `ScreenshotStore.recent`.
    pub fn recent(&self, limit: f64) -> Result<Vec<ScreenshotRow>> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM screenshots ORDER BY captured_at DESC LIMIT ?")?;
        stmt.query_map([limit], map_row)?.collect()
    }

    /// Port of `ScreenshotStore.find`.
    pub fn find(&self, id: &str) -> Result<Option<ScreenshotRow>> {
        self.conn
            .query_row("SELECT * FROM screenshots WHERE id = ?", [id], map_row)
            .optional()
    }

    /// Port of `ScreenshotStore.countSince`.
    pub fn count_since(&self, since_ms: f64) -> Result<f64> {
        self.conn.query_row(
            "SELECT COUNT(*) AS n FROM screenshots WHERE captured_at >= ?",
            [since_ms],
            |r| number_at(r, "n"),
        )
    }

    /// Port of `ScreenshotStore.pending`. `now_ms` is its `now = Date.now()` default, injected.
    pub fn pending(&self, limit: f64, now_ms: f64) -> Result<Vec<ScreenshotRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT * FROM screenshots
         WHERE upload_state='pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY captured_at ASC LIMIT ?",
        )?;
        stmt.query_map([now_ms, limit], map_row)?.collect()
    }

    /// Mark a row as actively uploading (so a concurrent drain skips it).
    /// Port of `ScreenshotStore.markUploading`.
    pub fn mark_uploading(&self, id: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE screenshots SET upload_state='uploading', next_attempt_at=NULL WHERE id = ?",
            [id],
        )?;
        Ok(())
    }

    /// Mark a row uploaded and record the Cloudinary `public_id` as the key.
    /// Port of `ScreenshotStore.markUploaded`.
    pub fn mark_uploaded(&self, id: &str, key: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE screenshots
         SET upload_state='uploaded',
             s3_key=@key,
             last_error=NULL,
             next_attempt_at=NULL,
             failed_at=NULL
         WHERE id=@id",
            named_params! { "@id": id, "@key": key },
        )?;
        Ok(())
    }

    /// Return a row to pending without consuming an attempt (auth/storage
    /// unavailable). Port of `ScreenshotStore.markPending`; `None` is its `null` default.
    pub fn mark_pending(
        &self,
        id: &str,
        last_error: Option<&str>,
        next_attempt_at: Option<f64>,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE screenshots
         SET upload_state='pending',
             last_error=@lastError,
             next_attempt_at=@nextAttemptAt,
             failed_at=NULL
         WHERE id=@id",
            named_params! { "@id": id, "@lastError": last_error, "@nextAttemptAt": next_attempt_at },
        )?;
        Ok(())
    }

    /// Schedule a retryable failure with backoff and a consumed attempt.
    /// Port of `ScreenshotStore.markRetryScheduled`.
    pub fn mark_retry_scheduled(
        &self,
        id: &str,
        last_error: &str,
        next_attempt_at: f64,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE screenshots
         SET upload_state='pending',
             attempts=attempts+1,
             last_error=@lastError,
             next_attempt_at=@nextAttemptAt,
             failed_at=NULL
         WHERE id=@id",
            named_params! { "@id": id, "@lastError": last_error, "@nextAttemptAt": next_attempt_at },
        )?;
        Ok(())
    }

    /// Mark a row terminally failed after a hard error or retry cap. Port of
    /// `ScreenshotStore.markTerminalFailed`; `failed_at` is its `Date.now()` default, injected.
    pub fn mark_terminal_failed(&self, id: &str, last_error: &str, failed_at: f64) -> Result<()> {
        self.conn.execute(
            "UPDATE screenshots
         SET upload_state='failed',
             attempts=attempts+1,
             last_error=@lastError,
             next_attempt_at=NULL,
             failed_at=@failedAt
         WHERE id=@id",
            named_params! { "@id": id, "@lastError": last_error, "@failedAt": failed_at },
        )?;
        Ok(())
    }

    /// Port of `ScreenshotStore.resetFailedUploads`: how many rows went back to pending.
    pub fn reset_failed_uploads(&self) -> Result<usize> {
        self.conn.execute(
            "UPDATE screenshots
         SET upload_state='pending',
             attempts=0,
             last_error=NULL,
             next_attempt_at=NULL,
             failed_at=NULL
         WHERE upload_state='failed'",
            [],
        )
    }

    /// Port of `ScreenshotStore.uploadSummary`.
    pub fn upload_summary(&self) -> Result<ScreenshotUploadSummary> {
        let mut out = ScreenshotUploadSummary {
            pending: 0.0,
            uploading: 0.0,
            failed: 0.0,
        };
        let mut stmt = self.conn.prepare(
            "SELECT upload_state AS state, COUNT(*) AS n FROM screenshots GROUP BY upload_state",
        )?;
        let rows = stmt.query_map([], |r| Ok((string_at(r, "state")?, number_at(r, "n")?)))?;
        for row in rows {
            let (state, n) = row?;
            match state.as_str() {
                PENDING => out.pending = n,
                UPLOADING => out.uploading = n,
                FAILED => out.failed = n,
                _ => {}
            }
        }
        Ok(out)
    }

    /// Minimal projection of every row, for the retention planner.
    /// Port of `ScreenshotStore.allForRetention`.
    pub fn all_for_retention(&self) -> Result<Vec<RetentionRow>> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, file_path, captured_at FROM screenshots")?;
        stmt.query_map([], |r| {
            Ok(RetentionRow {
                id: js_string(r.get_ref("id")?),
                file_path: js_string(r.get_ref("file_path")?),
                captured_at: js_number(r.get_ref("captured_at")?),
            })
        })?
        .collect()
    }

    /// Delete rows by id (retention / reconciliation), in one transaction.
    /// Port of `ScreenshotStore.deleteByIds`.
    pub fn delete_by_ids(&mut self, ids: &[String]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let tx = self.conn.transaction()?;
        {
            let mut stmt = tx.prepare("DELETE FROM screenshots WHERE id = ?")?;
            for id in ids {
                stmt.execute([id])?;
            }
        }
        tx.commit()
    }
}
