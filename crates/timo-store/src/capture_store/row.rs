//! The screenshot row and its summaries.

use rusqlite::{Result, Row};
use serde::{Deserialize, Serialize};

use crate::row_value::{number_at, opt_number_at, opt_string_at, string_at};

/// `upload_state` values the stores write. The column is free text, as in the
/// TypeScript (`String(r.upload_state) as UploadState`): a value written by
/// something else is carried verbatim, never rejected.
pub const PENDING: &str = "pending";
/// Mid-flight; boot puts these back to [`PENDING`].
pub const UPLOADING: &str = "uploading";
/// On the server.
pub const UPLOADED: &str = "uploaded";
/// Written off after a hard error or the retry cap.
pub const FAILED: &str = "failed";

/// Port of `ScreenshotRow`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotRow {
    pub id: String,
    pub time_entry_id: Option<String>,
    pub display_id: String,
    pub captured_at: f64,
    pub file_path: String,
    pub bytes: f64,
    pub width: f64,
    pub height: f64,
    pub upload_state: String,
    pub attempts: f64,
    pub s3_key: Option<String>,
    pub last_error: Option<String>,
    pub next_attempt_at: Option<f64>,
    pub failed_at: Option<f64>,
}

/// Port of `ScreenshotUploadSummary`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct ScreenshotUploadSummary {
    pub pending: f64,
    pub uploading: f64,
    pub failed: f64,
}

/// The retention planner's projection of a row (`allForRetention`).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetentionRow {
    pub id: String,
    pub file_path: String,
    pub captured_at: f64,
}

/// Port of `legacy/agent/src/main/services/capture/store.ts::mapRow`.
pub(super) fn map_row(r: &Row<'_>) -> Result<ScreenshotRow> {
    Ok(ScreenshotRow {
        id: string_at(r, "id")?,
        time_entry_id: opt_string_at(r, "time_entry_id")?,
        display_id: string_at(r, "display_id")?,
        captured_at: number_at(r, "captured_at")?,
        file_path: string_at(r, "file_path")?,
        bytes: number_at(r, "bytes")?,
        width: number_at(r, "width")?,
        height: number_at(r, "height")?,
        upload_state: string_at(r, "upload_state")?,
        attempts: number_at(r, "attempts")?,
        s3_key: opt_string_at(r, "s3_key")?,
        last_error: opt_string_at(r, "last_error")?,
        next_attempt_at: opt_number_at(r, "next_attempt_at")?,
        failed_at: opt_number_at(r, "failed_at")?,
    })
}
