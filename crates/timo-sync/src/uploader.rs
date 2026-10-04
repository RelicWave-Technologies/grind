//! Sign, upload, complete. Port of the flow half of
//! `legacy/agent/src/main/services/capture/uploader.ts` (`uploadOne`,
//! `uploadScreenshotsNow`, `drainUploads`, `startUploader`): ask the API to sign
//! the upload, POST the bytes straight to Cloudinary, then tell the API where
//! they landed. The Cloudinary `api_secret` stays on the server.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use reqwest::multipart::{Form, Part};
use timo_core::js::number::number_to_string;
use tokio::task::JoinHandle;

use crate::api::ApiClient;
use crate::error::ApiError;
use crate::http::RequestOptions;
use crate::tokens::TokenStore;
use crate::uploader_policy::{
    UploadError, UploadFailureDecision, screenshot_upload_failure_decision,
};
use crate::uploader_types::{
    CloudinaryReply, CompleteFailed, CompleteUploaded, Landed, SignBody, Signed,
};
pub use crate::uploader_types::{ScreenshotQueue, ScreenshotRow};
use crate::wire::{iso, json_body};

/// Shots uploaded per drain pass.
pub const BATCH: usize = 5;
/// Background drain cadence.
pub const DRAIN_INTERVAL_MS: u64 = 60_000;

pub struct Uploader<S: TokenStore, Q: ScreenshotQueue> {
    api: Arc<ApiClient<S>>,
    queue: Arc<Q>,
    draining: AtomicBool,
    timer: std::sync::Mutex<Option<JoinHandle<()>>>,
}

impl<S: TokenStore, Q: ScreenshotQueue> std::fmt::Debug for Uploader<S, Q> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Uploader").finish_non_exhaustive()
    }
}

impl<S: TokenStore, Q: ScreenshotQueue> Uploader<S, Q> {
    pub fn new(api: Arc<ApiClient<S>>, queue: Arc<Q>) -> Arc<Self> {
        Arc::new(Self {
            api,
            queue,
            draining: AtomicBool::new(false),
            timer: std::sync::Mutex::new(None),
        })
    }

    /// `uploadOne`: a failure is recorded in the queue by the policy, then
    /// returned (the TypeScript rethrows).
    pub async fn upload_one(&self, row: &ScreenshotRow) -> Result<(), UploadError> {
        match self.try_upload(row).await {
            Ok(()) => Ok(()),
            Err(err) => {
                self.handle_failure(row, &err).await;
                Err(err)
            }
        }
    }

    async fn try_upload(&self, row: &ScreenshotRow) -> Result<(), UploadError> {
        // 1. Sign first: this also surfaces "not logged in" / "cloudinary off".
        let sign = RequestOptions::post(Some(
            json_body(&SignBody { id: &row.id }).map_err(UploadError::Api)?,
        ));
        let signed: Signed = self
            .api
            .api("/v1/screenshots/sign", &sign)
            .await
            .map_err(UploadError::Api)?;
        self.queue
            .mark_uploading(&row.id)
            .map_err(UploadError::Other)?;
        self.queue.changed();
        let bytes = read_file(&row.file_path).await?;
        let reply = self.post_to_cloudinary(row, &signed, bytes).await?;
        let full_url = reply.secure_url.filter(|u| !u.is_empty()).ok_or_else(|| {
            UploadError::Other("cloudinary response missing secure_url".to_owned())
        })?;
        // A gallery thumbnail via an on-the-fly transformation: the FIRST match only.
        let thumb_url = full_url.replacen(
            "/image/upload/",
            &format!("/image/upload/{}/", signed.thumb_transform),
            1,
        );
        let key = reply.public_id.as_deref().unwrap_or(&signed.public_id);
        let landed = Landed {
            key,
            full_url: &full_url,
            thumb_url: &thumb_url,
        };
        self.complete_uploaded(row, &landed).await?;
        self.queue
            .mark_uploaded(&row.id, key)
            .map_err(UploadError::Other)?;
        self.queue.changed();
        tracing::info!(id = %row.id, "screenshot uploaded");
        Ok(())
    }

    async fn post_to_cloudinary(
        &self,
        row: &ScreenshotRow,
        signed: &Signed,
        bytes: Vec<u8>,
    ) -> Result<CloudinaryReply, UploadError> {
        let file = Part::bytes(bytes)
            .file_name(format!("{}.webp", row.id))
            .mime_str("image/webp")
            .map_err(|e| UploadError::Other(e.to_string()))?;
        // Field order is the TypeScript's append order.
        let form = Form::new()
            .part("file", file)
            .text("api_key", signed.api_key.clone())
            .text("timestamp", number_to_string(signed.timestamp))
            .text("public_id", signed.public_id.clone())
            .text("folder", signed.folder.clone())
            .text("signature", signed.signature.clone());
        let response = self
            .api
            .transport()
            .client()
            .post(&signed.upload_url)
            .multipart(form)
            .send()
            .await
            .map_err(|e| UploadError::Api(ApiError::Network(e.to_string())))?;
        let status = response.status();
        let body = response
            .bytes()
            .await
            .map_err(|e| UploadError::Api(ApiError::Network(e.to_string())));
        if !status.is_success() {
            let text = body
                .map(|b| String::from_utf8_lossy(&b).into_owned())
                .unwrap_or_default();
            return Err(UploadError::Cloudinary {
                status: status.as_u16(),
                body: text,
            });
        }
        serde_json::from_slice(&body?)
            .map_err(|e| UploadError::Api(ApiError::Syntax(e.to_string())))
    }

    async fn complete_uploaded(
        &self,
        row: &ScreenshotRow,
        landed: &Landed<'_>,
    ) -> Result<(), UploadError> {
        let body = CompleteUploaded {
            id: &row.id,
            time_entry_id: row.time_entry_id.as_deref(),
            display_id: &row.display_id,
            captured_at: iso(row.captured_at).map_err(UploadError::Api)?,
            s3_key: landed.key,
            full_url: landed.full_url,
            thumb_url: landed.thumb_url,
            bytes: row.bytes,
            width: row.width,
            height: row.height,
            upload_state: "UPLOADED",
        };
        let options = RequestOptions::post(Some(json_body(&body).map_err(UploadError::Api)?));
        self.api
            .api::<serde_json::Value>("/v1/screenshots/complete", &options)
            .await
            .map_err(UploadError::Api)?;
        Ok(())
    }

    /// `notifyServerFailed`.
    async fn notify_server_failed(&self, row: &ScreenshotRow) -> Result<(), ApiError> {
        let body = CompleteFailed {
            id: &row.id,
            time_entry_id: row.time_entry_id.as_deref(),
            display_id: &row.display_id,
            captured_at: iso(row.captured_at)?,
            bytes: row.bytes,
            width: row.width,
            height: row.height,
            upload_state: "FAILED",
        };
        let options = RequestOptions::post(Some(json_body(&body)?));
        self.api
            .api::<serde_json::Value>("/v1/screenshots/complete", &options)
            .await?;
        Ok(())
    }

    /// `handleUploadFailure`.
    async fn handle_failure(&self, row: &ScreenshotRow, err: &UploadError) {
        let mut rng = || self.queue.random();
        let decision =
            screenshot_upload_failure_decision(row.attempts, err, self.queue.now_ms(), &mut rng);
        let queue = &self.queue;
        let written = match &decision {
            UploadFailureDecision::Pending {
                last_error,
                next_attempt_at,
            } => queue.mark_pending(&row.id, last_error, *next_attempt_at),
            UploadFailureDecision::Retry {
                last_error,
                next_attempt_at,
            } => queue.mark_retry_scheduled(&row.id, last_error, *next_attempt_at),
            UploadFailureDecision::Failed { last_error } => {
                queue.mark_terminal_failed(&row.id, last_error)
            }
        };
        if let Err(message) = written {
            tracing::warn!(id = %row.id, err = %message, "could not record upload failure");
        }
        queue.changed();
        if matches!(decision, UploadFailureDecision::Failed { .. })
            && let Err(notify_err) = self.notify_server_failed(row).await
            && !UploadError::Api(notify_err.clone()).is_non_counting()
        {
            tracing::debug!(id = %row.id, err = %notify_err.message(), "failed screenshot server audit update failed");
        }
    }

    /// `uploadScreenshotsNow(rows)`: fresh rows first, before older backlog.
    pub async fn upload_screenshots_now(&self, rows: &[ScreenshotRow]) {
        self.upload_each(rows).await;
    }

    /// `drainUploads`: the pending queue, `BATCH` at a time; overlapping calls
    /// are skipped. Not logged in or storage unconfigured stops the pass.
    pub async fn drain_uploads(&self) {
        if self.draining.swap(true, Ordering::SeqCst) {
            return;
        }
        match self.queue.pending(BATCH) {
            Ok(rows) => self.upload_each(&rows).await,
            Err(message) => tracing::warn!(err = %message, "could not read pending screenshots"),
        }
        self.draining.store(false, Ordering::SeqCst);
    }

    async fn upload_each(&self, rows: &[ScreenshotRow]) {
        for row in rows {
            if let Err(err) = self.upload_one(row).await {
                if err.is_non_counting() {
                    return;
                }
                tracing::warn!(id = %row.id, err = %err.message(), "screenshot upload failed");
            }
        }
    }

    /// `startUploader`: idempotent; one drain now, then every 60 s.
    pub fn start(self: &Arc<Self>) {
        let Ok(mut slot) = self.timer.lock() else {
            return;
        };
        if slot.is_some() {
            return;
        }
        let me = Arc::clone(self);
        *slot = Some(tokio::spawn(async move {
            me.drain_uploads().await;
            let every = Duration::from_millis(DRAIN_INTERVAL_MS);
            let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
            loop {
                tick.tick().await;
                let again = Arc::clone(&me);
                drop(tokio::spawn(async move { again.drain_uploads().await }));
            }
        }));
    }
}

/// `fs.readFile`: a missing file is `ENOENT`, which the policy calls terminal.
async fn read_file(path: &str) -> Result<Vec<u8>, UploadError> {
    tokio::fs::read(path).await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            UploadError::LocalFileMissing {
                path: path.to_owned(),
            }
        } else {
            UploadError::Other(e.to_string())
        }
    })
}
