//! `capture/uploader.ts` parity: the retry/failure policy over every kind of
//! error, and the whole sign -> Cloudinary -> complete flow (request bodies,
//! multipart fields in order, every store mark) against the REAL TypeScript.
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

use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use support::{MockServer, Recorded, Reply, f, fixture, s, tokens};
use timo_core::js::number::number_to_string;
use timo_sync::tokens::MemoryTokenStore;
use timo_sync::uploader::{ScreenshotQueue, ScreenshotRow, Uploader};
use timo_sync::uploader_policy::{
    UploadError, UploadFailureDecision, screenshot_retry_delay_ms,
    screenshot_upload_failure_decision,
};
use timo_sync::{ApiClient, ApiError};

fn upload_error(v: &Value) -> UploadError {
    match s(&v["kind"]).as_str() {
        "unauthorized" => UploadError::Api(ApiError::Unauthorized(s(&v["message"]))),
        "http" => UploadError::Api(ApiError::Http {
            path: s(&v["path"]),
            status: u16::try_from(v["status"].as_u64().unwrap()).unwrap(),
            body: s(&v["body"]),
        }),
        "cloudinary" => UploadError::Cloudinary {
            status: u16::try_from(v["status"].as_u64().unwrap()).unwrap(),
            body: s(&v["body"]),
        },
        "enoent" => UploadError::LocalFileMissing {
            path: s(&v["path"]),
        },
        _ => UploadError::Other(s(&v["message"])),
    }
}

#[test]
fn retry_delay_matches_the_typescript() {
    let cases = fixture("uploader", "screenshot_retry_delay_ms");
    for (i, case) in cases.iter().enumerate() {
        let rng = f(&case.input["rng"]);
        let got = screenshot_retry_delay_ms(case.input["n"].as_i64().unwrap(), &mut || rng);
        assert_eq!(
            got.to_bits(),
            f(&case.output).to_bits(),
            "case {i}: {}",
            case.input
        );
    }
}

#[test]
fn failure_decisions_match_the_typescript() {
    let cases = fixture("uploader", "screenshot_upload_failure_decision");
    let mut seen = [0_usize; 3];
    for (i, case) in cases.iter().enumerate() {
        let i_ = &case.input;
        let rng = f(&i_["rng"]);
        let got = screenshot_upload_failure_decision(
            i_["attempts"].as_i64().unwrap(),
            &upload_error(&i_["err"]),
            f(&i_["now"]),
            &mut || rng,
        );
        let want = &case.output;
        let (action, last_error, next) = match &got {
            UploadFailureDecision::Pending {
                last_error,
                next_attempt_at,
            } => {
                seen[0] += 1;
                ("pending", last_error, Some(*next_attempt_at))
            }
            UploadFailureDecision::Retry {
                last_error,
                next_attempt_at,
            } => {
                seen[1] += 1;
                ("retry", last_error, Some(*next_attempt_at))
            }
            UploadFailureDecision::Failed { last_error } => {
                seen[2] += 1;
                ("failed", last_error, None)
            }
        };
        assert_eq!(action, s(&want["action"]), "case {i}: {i_}");
        assert_eq!(last_error, &s(&want["lastError"]), "case {i}: {i_}");
        assert_eq!(
            next.map(f64::to_bits),
            want.get("nextAttemptAt").map(|v| f(v).to_bits()),
            "case {i}: {i_}"
        );
    }
    assert!(
        seen.iter().all(|n| *n > 20),
        "every action is exercised: {seen:?}"
    );
}

// ---------------- the flow ----------------

struct Queue {
    log: Mutex<Vec<String>>,
    now: f64,
    rng: f64,
}

impl Queue {
    fn note(&self, parts: &[&str]) {
        self.log.lock().unwrap().push(parts.join("|"));
    }
}

impl ScreenshotQueue for Queue {
    fn pending(&self, _: usize) -> Result<Vec<ScreenshotRow>, String> {
        Ok(Vec::new())
    }
    fn mark_uploading(&self, id: &str) -> Result<(), String> {
        self.note(&["markUploading", id]);
        Ok(())
    }
    fn mark_uploaded(&self, id: &str, key: &str) -> Result<(), String> {
        self.note(&["markUploaded", id, key]);
        Ok(())
    }
    fn mark_pending(&self, id: &str, e: &str, at: f64) -> Result<(), String> {
        self.note(&["markPending", id, e, &number_to_string(at)]);
        Ok(())
    }
    fn mark_retry_scheduled(&self, id: &str, e: &str, at: f64) -> Result<(), String> {
        self.note(&["markRetryScheduled", id, e, &number_to_string(at)]);
        Ok(())
    }
    fn mark_terminal_failed(&self, id: &str, e: &str) -> Result<(), String> {
        self.note(&["markTerminalFailed", id, e]);
        Ok(())
    }
    fn changed(&self) {
        self.log.lock().unwrap().push("broadcast".to_owned());
    }
    fn now_ms(&self) -> f64 {
        self.now
    }
    fn random(&self) -> f64 {
        self.rng
    }
}

/// `FormData.entries()` of the request, from the raw multipart body.
fn multipart_fields(request: &Recorded) -> Vec<Value> {
    let content_type = request.header("content-type").unwrap();
    let boundary = content_type.split("boundary=").nth(1).unwrap();
    let delimiter = format!("--{boundary}");
    let mut fields = Vec::new();
    for part in request.body.split(&delimiter).skip(1) {
        if part.starts_with("--") {
            break;
        }
        let (head, data) = part
            .trim_start_matches("\r\n")
            .split_once("\r\n\r\n")
            .unwrap();
        let data = data.strip_suffix("\r\n").unwrap();
        let name = head
            .split("name=\"")
            .nth(1)
            .unwrap()
            .split('"')
            .next()
            .unwrap();
        if let Some(file) = head.split("filename=\"").nth(1) {
            let kind = head
                .lines()
                .find_map(|l| l.strip_prefix("Content-Type: "))
                .unwrap_or("");
            fields.push(json!([name, {"file": file.split('"').next().unwrap(), "type": kind, "size": data.len()}]));
        } else {
            fields.push(json!([name, data]));
        }
    }
    fields
}

#[tokio::test]
async fn the_upload_flow_matches_the_typescript() {
    let cases = fixture("uploader", "upload_screenshots_now");
    let dir = std::path::PathBuf::from("/tmp/timo-d7/uploader-parity");
    std::fs::create_dir_all(&dir).unwrap();
    let mut outcomes = std::collections::BTreeMap::<String, usize>::new();
    for (i, case) in cases.iter().enumerate() {
        let input = &case.input;
        let row_in = &input["row"];
        let id = s(&row_in["id"]);
        let path = dir.join(format!("{id}.webp"));
        if input["fileExists"].as_bool().unwrap() {
            std::fs::write(
                &path,
                vec![0x57_u8; usize::try_from(row_in["bytes"].as_u64().unwrap()).unwrap()],
            )
            .unwrap();
        }
        let cloud_reply = input["cloud"].clone();
        let cloud = MockServer::start(move |_, _| match &cloud_reply {
            Value::String(_) => Reply::dropped(),
            reply => Reply::json(
                u16::try_from(reply["status"].as_u64().unwrap()).unwrap(),
                &s(&reply["body"]),
            ),
        })
        .await;
        let fixture_url = s(&input["signed"]["uploadUrl"]);
        let fixture_path = fixture_url
            .split_once("cloudinary.com")
            .unwrap()
            .1
            .to_owned();
        let upload_url = format!("{}{fixture_path}", cloud.base);
        let signed = {
            let mut v = input["signed"].clone();
            v["uploadUrl"] = json!(upload_url);
            json!({"cloudName": "demo", "apiKey": v["apiKey"], "uploadUrl": v["uploadUrl"], "timestamp": v["timestamp"], "signature": v["signature"], "publicId": v["publicId"], "folder": v["folder"], "thumbTransform": v["thumbTransform"]})
        };
        let (sign, complete) = (input["sign"].clone(), input["complete"].clone());
        let api_server = MockServer::start(move |_, req| {
            if req.path == "/v1/screenshots/sign" {
                match &sign {
                    Value::String(kind) if kind == "ok" => Reply::json(200, &signed.to_string()),
                    Value::String(_) => Reply::json(500, "unreachable"),
                    reply => Reply::json(
                        u16::try_from(reply["status"].as_u64().unwrap()).unwrap(),
                        &s(&reply["body"]),
                    ),
                }
            } else {
                Reply::json(
                    u16::try_from(complete["status"].as_u64().unwrap()).unwrap(),
                    &s(&complete["body"]),
                )
            }
        })
        .await;
        let no_session = input["sign"] == "unauthorized";
        let store = Arc::new(MemoryTokenStore::new(
            (!no_session).then(|| tokens("a", "r")),
        ));
        let api = Arc::new(ApiClient::new(&api_server.base, store).unwrap());
        let queue = Arc::new(Queue {
            log: Mutex::default(),
            now: f(&input["now"]),
            rng: f(&input["rng"]),
        });
        let uploader = Uploader::new(api, Arc::clone(&queue));
        let row = ScreenshotRow {
            id: id.clone(),
            time_entry_id: support::opt_s(&row_in["timeEntryId"]),
            display_id: s(&row_in["displayId"]),
            captured_at: f(&row_in["capturedAt"]),
            file_path: path.to_string_lossy().into_owned(),
            bytes: f(&row_in["bytes"]),
            width: f(&row_in["width"]),
            height: f(&row_in["height"]),
            attempts: row_in["attempts"].as_i64().unwrap(),
        };

        uploader
            .upload_screenshots_now(std::slice::from_ref(&row))
            .await;

        let want = &case.output;
        let calls: Vec<Value> = api_server
            .requests()
            .iter()
            .map(|r| json!({"path": r.path, "bodyText": r.body}))
            .collect();
        let want_calls: Vec<Value> = want["api"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| json!({"path": c["path"], "bodyText": c["bodyText"]}))
            .collect();
        assert_eq!(calls, want_calls, "case {i}: API requests");
        let fetches: Vec<Value> = cloud
            .requests()
            .iter()
            .map(|r| json!({"path": r.path, "method": r.method, "fields": multipart_fields(r)}))
            .collect();
        let want_fetches: Vec<Value> = want["fetch"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| json!({"path": fixture_path, "method": c["method"], "fields": c["fields"]}))
            .collect();
        assert_eq!(fetches, want_fetches, "case {i}: Cloudinary requests");
        assert_eq!(
            json!(queue.log.lock().unwrap().clone()),
            want["store"],
            "case {i}: store marks"
        );
        *outcomes
            .entry(
                want["store"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .filter_map(|l| l.as_str())
                    .find(|l| l.starts_with("mark") && !l.starts_with("markUploading"))
                    .unwrap_or("none")
                    .split('|')
                    .next()
                    .unwrap()
                    .to_owned(),
            )
            .or_default() += 1;
        std::fs::remove_file(&path).ok();
        drop((api_server, cloud));
    }
    for outcome in [
        "markUploaded",
        "markPending",
        "markRetryScheduled",
        "markTerminalFailed",
    ] {
        assert!(
            outcomes.get(outcome).copied().unwrap_or(0) > 10,
            "{outcome} is exercised: {outcomes:?}"
        );
    }
}
