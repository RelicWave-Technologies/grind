//! The rows, queue seam and wire shapes of the screenshot uploader.

use serde::{Deserialize, Serialize};

/// The slice of `capture/store.ts::ScreenshotRow` the uploader reads.
#[derive(Debug, Clone, PartialEq)]
pub struct ScreenshotRow {
    pub id: String,
    pub time_entry_id: Option<String>,
    pub display_id: String,
    /// A JavaScript number: the server-aligned clock is fractional.
    pub captured_at: f64,
    pub file_path: String,
    pub bytes: f64,
    pub width: f64,
    pub height: f64,
    pub attempts: i64,
}

/// The slice of `ScreenshotStore` the uploader writes through, plus the clock
/// and dice the policy needs (`Date.now()`, `Math.random`).
pub trait ScreenshotQueue: Send + Sync + 'static {
    fn pending(&self, limit: usize) -> Result<Vec<ScreenshotRow>, String>;
    fn mark_uploading(&self, id: &str) -> Result<(), String>;
    fn mark_uploaded(&self, id: &str, key: &str) -> Result<(), String>;
    fn mark_pending(&self, id: &str, last_error: &str, next_attempt_at: f64) -> Result<(), String>;
    fn mark_retry_scheduled(
        &self,
        id: &str,
        last_error: &str,
        next_attempt_at: f64,
    ) -> Result<(), String>;
    /// `markTerminalFailed(id, lastError)`: stamps `failedAt = Date.now()`.
    fn mark_terminal_failed(&self, id: &str, last_error: &str) -> Result<(), String>;
    /// `broadcastScreenshotChange()`.
    fn changed(&self);
    fn now_ms(&self) -> f64;
    /// `Math.random()`.
    fn random(&self) -> f64;
}

/// `SignScreenshotUploadResponse`, cast and not parsed.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Signed {
    pub(crate) api_key: String,
    pub(crate) upload_url: String,
    pub(crate) timestamp: f64,
    pub(crate) signature: String,
    pub(crate) public_id: String,
    pub(crate) folder: String,
    pub(crate) thumb_transform: String,
}

#[derive(Deserialize)]
pub(crate) struct CloudinaryReply {
    #[serde(default)]
    pub(crate) secure_url: Option<String>,
    #[serde(default)]
    pub(crate) public_id: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct SignBody<'a> {
    pub(crate) id: &'a str,
}

/// Where Cloudinary put the shot.
pub(crate) struct Landed<'a> {
    pub(crate) key: &'a str,
    pub(crate) full_url: &'a str,
    pub(crate) thumb_url: &'a str,
}

/// `CompleteScreenshotUploadRequest` for an upload that landed.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompleteUploaded<'a> {
    pub(crate) id: &'a str,
    pub(crate) time_entry_id: Option<&'a str>,
    pub(crate) display_id: &'a str,
    pub(crate) captured_at: String,
    pub(crate) s3_key: &'a str,
    pub(crate) full_url: &'a str,
    pub(crate) thumb_url: &'a str,
    pub(crate) bytes: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) upload_state: &'static str,
}

/// `CompleteScreenshotUploadRequest` for the best-effort `FAILED` notice.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CompleteFailed<'a> {
    pub(crate) id: &'a str,
    pub(crate) time_entry_id: Option<&'a str>,
    pub(crate) display_id: &'a str,
    pub(crate) captured_at: String,
    pub(crate) bytes: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) upload_state: &'static str,
}
