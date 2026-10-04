//! Port of `capture/uploader.test.ts` (7 tests: the retry decisions) and the
//! sign -> Cloudinary -> complete flow of `uploadOne`/`drainUploads`, against
//! loopback servers standing in for the API and for Cloudinary.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::string_slice,
    clippy::too_many_lines,
    clippy::too_many_arguments,
    reason = "test code: a failed assertion is the failure report"
)]

mod support;

use std::sync::Arc;
use std::sync::Mutex;

use support::{MockServer, Reply, tokens};
use timo_sync::tokens::MemoryTokenStore;
use timo_sync::uploader::{ScreenshotQueue, ScreenshotRow, Uploader};
use timo_sync::uploader_policy::{
    UploadError, UploadFailureDecision, screenshot_retry_delay_ms,
    screenshot_upload_failure_decision,
};
use timo_sync::{ApiClient, ApiError};

fn decide(attempts: i64, err: &UploadError, now: f64, rng: f64) -> UploadFailureDecision {
    screenshot_upload_failure_decision(attempts, err, now, &mut || rng)
}

fn http(status: u16, body: &str) -> UploadError {
    UploadError::Api(ApiError::Http {
        path: "/v1/screenshots/sign".to_owned(),
        status,
        body: body.to_owned(),
    })
}

#[test]
fn uses_capped_exponential_backoff_with_a_one_minute_floor() {
    assert!((screenshot_retry_delay_ms(1, &mut || 0.0) - 60_000.0).abs() < f64::EPSILON);
    assert!((screenshot_retry_delay_ms(2, &mut || 0.5) - 90_000.0).abs() < f64::EPSILON);
    assert!((screenshot_retry_delay_ms(20, &mut || 1.0) - 3_600_000.0).abs() < f64::EPSILON);
}

#[test]
fn does_not_consume_attempts_for_auth_failures() {
    let err = UploadError::Api(ApiError::Unauthorized("no_tokens".to_owned()));
    assert_eq!(
        decide(4, &err, 1_000.0, 0.0),
        UploadFailureDecision::Pending {
            last_error: "no_tokens".to_owned(),
            next_attempt_at: 61_000.0
        }
    );
}

#[test]
fn does_not_consume_attempts_when_storage_is_not_configured() {
    assert_eq!(
        decide(4, &http(503, "cloudinary_not_configured"), 1_000.0, 0.0),
        UploadFailureDecision::Pending {
            last_error: "/v1/screenshots/sign 503: cloudinary_not_configured".to_owned(),
            next_attempt_at: 61_000.0,
        }
    );
}

#[test]
fn schedules_retryable_failures_below_the_cap() {
    let err = UploadError::Other("network reset".to_owned());
    assert_eq!(
        decide(1, &err, 1_000.0, 0.5),
        UploadFailureDecision::Retry {
            last_error: "network reset".to_owned(),
            next_attempt_at: 91_000.0
        }
    );
}

#[test]
fn moves_the_fifth_retryable_failure_to_failed() {
    let err = UploadError::Other("network reset".to_owned());
    assert_eq!(
        decide(4, &err, 1_000.0, 0.99),
        UploadFailureDecision::Failed {
            last_error: "network reset".to_owned()
        }
    );
}

#[test]
fn treats_local_missing_files_and_cloudinary_hard_4xx_responses_as_terminal() {
    let missing = UploadError::LocalFileMissing {
        path: "/x.webp".to_owned(),
    };
    assert!(matches!(
        decide(0, &missing, 1_000.0, 0.0),
        UploadFailureDecision::Failed { .. }
    ));
    let bad = UploadError::Cloudinary {
        status: 401,
        body: "bad signature".to_owned(),
    };
    assert_eq!(
        decide(0, &bad, 1_000.0, 0.0),
        UploadFailureDecision::Failed {
            last_error: "cloudinary 401: bad signature".to_owned()
        }
    );
}

#[test]
fn keeps_throttling_style_cloudinary_4xx_responses_retryable() {
    let throttled = UploadError::Cloudinary {
        status: 429,
        body: "too many requests".to_owned(),
    };
    assert_eq!(
        decide(0, &throttled, 1_000.0, 0.0),
        UploadFailureDecision::Retry {
            last_error: "cloudinary 429: too many requests".to_owned(),
            next_attempt_at: 61_000.0,
        }
    );
    let timeout = UploadError::Cloudinary {
        status: 408,
        body: String::new(),
    };
    assert!(matches!(
        decide(0, &timeout, 1_000.0, 0.0),
        UploadFailureDecision::Retry { .. }
    ));
}

#[test]
fn the_cloudinary_error_message_keeps_the_first_200_utf16_units_of_the_body() {
    let long = UploadError::Cloudinary {
        status: 500,
        body: "x".repeat(300),
    };
    assert_eq!(
        long.message(),
        format!("cloudinary 500: {}", "x".repeat(200))
    );
}

#[test]
fn a_503_or_an_unconfigured_message_never_counts_but_other_statuses_do() {
    assert!(http(503, "busy").is_non_counting());
    assert!(UploadError::Other("storage_not_configured".to_owned()).is_non_counting());
    assert!(!http(500, "boom").is_non_counting());
}

// ---------------- the flow ----------------

#[derive(Default)]
struct Queue {
    calls: Mutex<Vec<String>>,
    pending: Mutex<Vec<ScreenshotRow>>,
}

impl Queue {
    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
    fn log(&self, what: String) {
        self.calls.lock().unwrap().push(what);
    }
}

impl ScreenshotQueue for Queue {
    fn pending(&self, limit: usize) -> Result<Vec<ScreenshotRow>, String> {
        Ok(self
            .pending
            .lock()
            .unwrap()
            .iter()
            .take(limit)
            .cloned()
            .collect())
    }
    fn mark_uploading(&self, id: &str) -> Result<(), String> {
        self.log(format!("uploading {id}"));
        Ok(())
    }
    fn mark_uploaded(&self, id: &str, key: &str) -> Result<(), String> {
        self.log(format!("uploaded {id} {key}"));
        Ok(())
    }
    fn mark_pending(&self, id: &str, e: &str, at: f64) -> Result<(), String> {
        self.log(format!("pending {id} {e} {at}"));
        Ok(())
    }
    fn mark_retry_scheduled(&self, id: &str, e: &str, at: f64) -> Result<(), String> {
        self.log(format!("retry {id} {e} {at}"));
        Ok(())
    }
    fn mark_terminal_failed(&self, id: &str, e: &str) -> Result<(), String> {
        self.log(format!("failed {id} {e}"));
        Ok(())
    }
    fn changed(&self) {}
    fn now_ms(&self) -> f64 {
        1_000.0
    }
    fn random(&self) -> f64 {
        0.0
    }
}

fn shot(dir: &std::path::Path, id: &str) -> ScreenshotRow {
    let path = dir.join(format!("{id}.webp"));
    std::fs::write(&path, b"RIFFfakewebp").unwrap();
    ScreenshotRow {
        id: id.to_owned(),
        time_entry_id: Some("entry-1".to_owned()),
        display_id: "d1".to_owned(),
        captured_at: 1_791_133_383_891.262_7,
        file_path: path.to_string_lossy().into_owned(),
        bytes: 12.0,
        width: 2560.0,
        height: 1440.0,
        attempts: 0,
    }
}

fn temp_dir(name: &str) -> std::path::PathBuf {
    let dir = std::path::PathBuf::from(format!(
        "/tmp/timo-d7/uploader-{name}-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

struct Rig {
    uploader: Arc<Uploader<MemoryTokenStore, Queue>>,
    queue: Arc<Queue>,
    api: MockServer,
    cloud: MockServer,
}

async fn rig(
    sign: impl Fn(&str) -> Reply + Send + Sync + 'static,
    cloud: Reply,
    complete: Reply,
) -> Rig {
    let cloud_server = MockServer::start(move |_, _| cloud.clone()).await;
    let upload_url = format!("{}/v1_1/demo/image/upload", cloud_server.base);
    let api_server = MockServer::start(move |_, req| match req.path.as_str() {
        "/v1/screenshots/sign" => sign(&upload_url),
        "/v1/screenshots/complete" => complete.clone(),
        other => Reply::json(404, other),
    })
    .await;
    let store = Arc::new(MemoryTokenStore::new(Some(tokens("a", "r"))));
    let api = Arc::new(ApiClient::new(&api_server.base, store).unwrap());
    let queue = Arc::new(Queue::default());
    Rig {
        uploader: Uploader::new(api, Arc::clone(&queue)),
        queue,
        api: api_server,
        cloud: cloud_server,
    }
}

fn signed(upload_url: &str) -> Reply {
    Reply::json(
        200,
        &format!(
            r#"{{"cloudName":"demo","apiKey":"key1","uploadUrl":"{upload_url}","timestamp":1791133384,"signature":"sig","publicId":"pub1","folder":"shots","thumbTransform":"c_fill,w_320"}}"#
        ),
    )
}

#[tokio::test]
async fn uploads_signs_posts_to_cloudinary_and_completes_with_the_exact_wire_bodies() {
    let dir = temp_dir("ok");
    let r = rig(
        signed,
        Reply::json(200, r#"{"secure_url":"https://res.example/demo/image/upload/v1/shots/pub1.webp","public_id":"shots/pub1"}"#),
        Reply::json(200, "{}"),
    )
    .await;
    let row = shot(&dir, "01SHOT");

    r.uploader.upload_one(&row).await.unwrap();

    let api = r.api.requests();
    assert_eq!(api[0].path, "/v1/screenshots/sign");
    assert_eq!(api[0].body, r#"{"id":"01SHOT"}"#);
    assert_eq!(api[0].header("authorization"), Some("Bearer a"));
    assert_eq!(api[1].path, "/v1/screenshots/complete");
    assert_eq!(
        api[1].body,
        r#"{"id":"01SHOT","timeEntryId":"entry-1","displayId":"d1","capturedAt":"2026-10-04T17:03:03.891Z","s3Key":"shots/pub1","fullUrl":"https://res.example/demo/image/upload/v1/shots/pub1.webp","thumbUrl":"https://res.example/demo/image/upload/c_fill,w_320/v1/shots/pub1.webp","bytes":12,"width":2560,"height":1440,"uploadState":"UPLOADED"}"#
    );
    let cloud = &r.cloud.requests()[0];
    assert_eq!(cloud.path, "/v1_1/demo/image/upload");
    assert_eq!(
        cloud.header("authorization"),
        None,
        "the signed form needs no bearer token"
    );
    assert!(
        cloud
            .header("content-type")
            .unwrap()
            .starts_with("multipart/form-data; boundary=")
    );
    // Field order is the TypeScript's append order.
    let names: Vec<&str> = cloud
        .body
        .match_indices("form-data; name=\"")
        .map(|(i, _)| {
            let rest = &cloud.body[i + 17..];
            &rest[..rest.find('"').unwrap()]
        })
        .collect();
    assert_eq!(
        names,
        [
            "file",
            "api_key",
            "timestamp",
            "public_id",
            "folder",
            "signature"
        ]
    );
    assert!(cloud.body.contains("filename=\"01SHOT.webp\""));
    assert!(cloud.body.contains("Content-Type: image/webp"));
    assert!(
        cloud.body.contains("\r\n\r\n1791133384\r\n"),
        "timestamp is String(number)"
    );
    assert_eq!(
        r.queue.calls(),
        ["uploading 01SHOT", "uploaded 01SHOT shots/pub1"]
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn a_cloudinary_hard_rejection_is_terminal_and_tells_the_server() {
    let dir = temp_dir("hard");
    let r = rig(
        signed,
        Reply::json(401, "bad signature"),
        Reply::json(200, "{}"),
    )
    .await;

    let err = r.uploader.upload_one(&shot(&dir, "S1")).await.unwrap_err();

    assert_eq!(err.message(), "cloudinary 401: bad signature");
    assert_eq!(
        r.queue.calls(),
        ["uploading S1", "failed S1 cloudinary 401: bad signature"]
    );
    let notice = &r.api.requests()[1];
    assert_eq!(notice.path, "/v1/screenshots/complete");
    assert_eq!(
        notice.body,
        r#"{"id":"S1","timeEntryId":"entry-1","displayId":"d1","capturedAt":"2026-10-04T17:03:03.891Z","bytes":12,"width":2560,"height":1440,"uploadState":"FAILED"}"#
    );
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn a_cloudinary_server_error_schedules_a_retry_that_consumes_an_attempt() {
    let dir = temp_dir("retry");
    let r = rig(signed, Reply::json(500, "oops"), Reply::json(200, "{}")).await;

    r.uploader.upload_one(&shot(&dir, "S2")).await.unwrap_err();

    assert_eq!(
        r.queue.calls(),
        ["uploading S2", "retry S2 cloudinary 500: oops 61000"]
    );
    assert_eq!(r.api.count(), 1, "no FAILED notice for a retry");
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn an_unconfigured_storage_503_on_sign_returns_the_shot_to_pending_without_an_attempt() {
    let dir = temp_dir("503");
    let r = rig(
        |_| Reply::json(503, "cloudinary_not_configured"),
        Reply::json(200, "{}"),
        Reply::json(200, "{}"),
    )
    .await;

    let err = r.uploader.upload_one(&shot(&dir, "S3")).await.unwrap_err();

    assert!(err.is_non_counting());
    assert_eq!(
        r.queue.calls(),
        ["pending S3 /v1/screenshots/sign 503: cloudinary_not_configured 61000"]
    );
    assert_eq!(r.cloud.count(), 0);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn a_missing_local_file_is_terminal() {
    let dir = temp_dir("enoent");
    let r = rig(signed, Reply::json(200, "{}"), Reply::json(200, "{}")).await;
    let mut row = shot(&dir, "S4");
    std::fs::remove_file(&row.file_path).unwrap();
    row.attempts = 0;

    let err = r.uploader.upload_one(&row).await.unwrap_err();

    assert!(matches!(err, UploadError::LocalFileMissing { .. }));
    assert!(r.queue.calls()[1].starts_with("failed S4 ENOENT: no such file or directory, open '"));
    assert_eq!(r.cloud.count(), 0);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn a_response_without_secure_url_is_a_retryable_error() {
    let dir = temp_dir("nourl");
    let r = rig(
        signed,
        Reply::json(200, r#"{"public_id":"p"}"#),
        Reply::json(200, "{}"),
    )
    .await;

    let err = r.uploader.upload_one(&shot(&dir, "S5")).await.unwrap_err();

    assert_eq!(err.message(), "cloudinary response missing secure_url");
    assert!(r.queue.calls()[1].starts_with("retry S5 cloudinary response missing secure_url"));
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn drain_uploads_stops_the_pass_on_a_non_counting_failure_and_leaves_the_rest() {
    let dir = temp_dir("drain");
    let r = rig(
        |_| Reply::json(503, "storage_not_configured"),
        Reply::json(200, "{}"),
        Reply::json(200, "{}"),
    )
    .await;
    *r.queue.pending.lock().unwrap() = vec![shot(&dir, "A"), shot(&dir, "B")];

    r.uploader.drain_uploads().await;

    assert_eq!(r.api.count(), 1, "the second shot is not even attempted");
    assert_eq!(r.queue.calls().len(), 1);
    std::fs::remove_dir_all(dir).unwrap();
}

#[tokio::test]
async fn drain_uploads_uploads_the_pending_batch_in_order() {
    let dir = temp_dir("drain-ok");
    let r = rig(
        signed,
        Reply::json(
            200,
            r#"{"secure_url":"https://r/image/upload/x.webp","public_id":"k"}"#,
        ),
        Reply::json(200, "{}"),
    )
    .await;
    *r.queue.pending.lock().unwrap() = vec![shot(&dir, "A"), shot(&dir, "B")];

    r.uploader.drain_uploads().await;

    assert_eq!(
        r.queue.calls(),
        ["uploading A", "uploaded A k", "uploading B", "uploaded B k"].map(String::from)
    );
    std::fs::remove_dir_all(dir).unwrap();
}
