//! Port of `activity/sync.test.ts` (8 tests) and `activity/syncDrain.test.ts`
//! (7 tests). The sender runs against a loopback server that checks the body
//! against the same limits the shared zod schema enforces.
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

use std::collections::VecDeque;
use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use support::{MockServer, Reply, tokens};
use timo_sync::ApiClient;
use timo_sync::activity_drain::{
    ActivityDrainDeps, ActivityDrainReason, ActivitySyncDrain, DrainConfig, DrainResult, Skipped,
};
use timo_sync::activity_sync::{ActivityOutbox, ActivityRow, cap, flush_activity};
use timo_sync::tokens::MemoryTokenStore;

fn row(id: &str) -> ActivityRow {
    ActivityRow {
        id: id.to_owned(),
        time_entry_id: Some("t".to_owned()),
        bucket_start: 0.0,
        keystrokes: 1.0,
        clicks: 1.0,
        mouse_distance_px: 0.0,
        scroll_events: 0.0,
        iki_cv: Some(0.0),
        move_speed_cv: Some(0.0),
        path_straightness: Some(0.0),
        active_app: Some("app".to_owned()),
        active_app_bundle: None,
        active_title: None,
        active_url: None,
    }
}

struct FakeStore {
    rows: Vec<ActivityRow>,
    synced: Mutex<Vec<String>>,
}

impl FakeStore {
    fn new(rows: Vec<ActivityRow>) -> Self {
        Self {
            rows,
            synced: Mutex::default(),
        }
    }
    fn synced(&self) -> Vec<String> {
        self.synced.lock().unwrap().clone()
    }
}

impl ActivityOutbox for FakeStore {
    fn unsynced(&self, limit: usize) -> Result<Vec<ActivityRow>, String> {
        Ok(self.rows.iter().take(limit).cloned().collect())
    }
    fn mark_synced(&self, ids: &[String]) -> Result<(), String> {
        self.synced.lock().unwrap().extend_from_slice(ids);
        Ok(())
    }
}

/// `ActivitySamplesRequest.parse` stand-in: 1..=500 samples, metadata caps.
fn accepts(reply: &'static str) -> impl Fn(usize, &support::Recorded) -> Reply + Send + Sync {
    move |_, req| {
        let body: serde_json::Value = serde_json::from_str(&req.body).expect("valid JSON body");
        let samples = body["samples"].as_array().expect("samples");
        assert!((1..=500).contains(&samples.len()));
        for s in samples {
            for (key, max) in [
                ("activeApp", 120),
                ("activeAppBundle", 200),
                ("activeTitle", 300),
                ("activeUrl", 2048),
            ] {
                if let Some(text) = s[key].as_str() {
                    assert!(text.encode_utf16().count() <= max, "{key} over {max}");
                }
            }
        }
        Reply::json(200, reply)
    }
}

fn api_for(server: &MockServer) -> ApiClient<MemoryTokenStore> {
    ApiClient::new(
        &server.base,
        Arc::new(MemoryTokenStore::new(Some(tokens("a", "r")))),
    )
    .unwrap()
}

fn sample_body(server: &MockServer) -> serde_json::Value {
    let req = server
        .requests()
        .into_iter()
        .find(|r| r.path == "/v1/activity-samples")
        .expect("request");
    serde_json::from_str(&req.body).unwrap()
}

fn nothing_pending(_: &str) -> bool {
    false
}

#[tokio::test]
async fn sends_nothing_when_there_is_no_backlog() {
    let server = MockServer::start(accepts(r#"{"accepted":1,"detached":0}"#)).await;
    let api = api_for(&server);

    assert_eq!(
        flush_activity(&api, &FakeStore::new(vec![]), &nothing_pending)
            .await
            .unwrap(),
        0
    );
    assert_eq!(server.count(), 0);
}

#[tokio::test]
async fn bounds_the_batch_by_bytes_so_the_body_never_exceeds_the_api_limit() {
    let server = MockServer::start(accepts(r#"{"accepted":1,"detached":0}"#)).await;
    let api = api_for(&server);
    let big_url = format!("https://x/{}", "a".repeat(2000));
    let rows: Vec<ActivityRow> = (0..500)
        .map(|i| ActivityRow {
            active_url: Some(big_url.clone()),
            ..row(&format!("r{i}"))
        })
        .collect();
    let store = FakeStore::new(rows);

    let sent = flush_activity(&api, &store, &nothing_pending)
        .await
        .unwrap();

    assert!(
        server.requests()[0].body.len() < 64 * 1024,
        "under the server cap"
    );
    assert!(sent > 0);
    assert!(sent < 500, "did not cram all 500 into one request");
    assert_eq!(
        store.synced().len(),
        sent,
        "marked exactly what it sent, not the rest"
    );
}

#[tokio::test]
async fn truncates_every_metadata_field_to_the_shared_api_contract() {
    let server = MockServer::start(accepts(r#"{"accepted":1,"detached":0}"#)).await;
    let api = api_for(&server);
    let store = FakeStore::new(vec![ActivityRow {
        active_app: Some("a".repeat(121)),
        active_app_bundle: Some("b".repeat(201)),
        active_title: Some("t".repeat(301)),
        active_url: Some("u".repeat(5000)),
        ..row("r1")
    }]);

    flush_activity(&api, &store, &nothing_pending)
        .await
        .unwrap();

    let body = sample_body(&server);
    let sample = &body["samples"][0];
    assert_eq!(sample["activeApp"].as_str().unwrap().len(), 120);
    assert_eq!(sample["activeAppBundle"].as_str().unwrap().len(), 200);
    assert_eq!(sample["activeTitle"].as_str().unwrap().len(), 300);
    assert_eq!(sample["activeUrl"].as_str().unwrap().len(), 2048);
}

#[tokio::test]
async fn always_sends_at_least_one_sample_even_if_it_alone_is_large() {
    let server = MockServer::start(accepts(r#"{"accepted":1,"detached":0}"#)).await;
    let api = api_for(&server);
    let store = FakeStore::new(vec![ActivityRow {
        active_url: Some("u".repeat(5000)),
        ..row("r1")
    }]);

    assert_eq!(
        flush_activity(&api, &store, &nothing_pending)
            .await
            .unwrap(),
        1
    );
    assert_eq!(store.synced(), ["r1"]);
}

#[tokio::test]
async fn holds_children_whose_timer_parent_has_not_been_created_yet() {
    let server = MockServer::start(accepts(r#"{"accepted":2,"detached":0}"#)).await;
    let api = api_for(&server);
    let store = FakeStore::new(vec![
        ActivityRow {
            time_entry_id: Some("pending-parent".into()),
            ..row("waiting")
        },
        ActivityRow {
            time_entry_id: Some("created-parent".into()),
            bucket_start: 60_000.0,
            ..row("ready")
        },
        ActivityRow {
            time_entry_id: None,
            bucket_start: 120_000.0,
            ..row("unlinked")
        },
    ]);

    let sent = flush_activity(&api, &store, &|id: &str| id == "pending-parent")
        .await
        .unwrap();

    assert_eq!(sent, 2);
    let ids: Vec<String> = sample_body(&server)["samples"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["id"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(ids, ["ready", "unlinked"]);
    assert_eq!(store.synced(), ["ready", "unlinked"]);
}

#[tokio::test]
async fn remains_compatible_with_an_older_api_response_without_detached_count() {
    let server = MockServer::start(accepts(r#"{"accepted":1}"#)).await;
    let api = api_for(&server);
    let store = FakeStore::new(vec![row("r1")]);

    assert_eq!(
        flush_activity(&api, &store, &nothing_pending)
            .await
            .unwrap(),
        1
    );
    assert_eq!(store.synced(), ["r1"]);
}

#[tokio::test]
async fn a_failed_post_leaves_the_rows_unsynced_and_rethrows() {
    let server = MockServer::sequence(vec![Reply::json(500, "down")]).await;
    let api = api_for(&server);
    let store = FakeStore::new(vec![row("r1")]);

    assert!(
        flush_activity(&api, &store, &nothing_pending)
            .await
            .is_err()
    );
    assert!(store.synced().is_empty());
}

/// U+1F600 is one character stored as TWO UTF-16 code units. Putting it at the
/// 300-character boundary makes the cut land inside it.
#[tokio::test]
async fn capping_a_title_that_ends_in_an_emoji_does_not_leave_half_an_emoji_behind() {
    let server = MockServer::start(accepts(r#"{"accepted":1,"detached":0}"#)).await;
    let api = api_for(&server);
    let title = format!("{}\u{1F600}tail", "a".repeat(299));
    let store = FakeStore::new(vec![ActivityRow {
        active_title: Some(title),
        ..row("r1")
    }]);

    flush_activity(&api, &store, &nothing_pending)
        .await
        .unwrap();

    let body = sample_body(&server);
    let sent = body["samples"][0]["activeTitle"].as_str().unwrap();
    assert_eq!(sent.encode_utf16().count(), 299);
    assert_eq!(sent, "a".repeat(299));
}

#[tokio::test]
async fn leaves_an_emoji_that_fits_completely_alone() {
    let server = MockServer::start(accepts(r#"{"accepted":1,"detached":0}"#)).await;
    let api = api_for(&server);
    let fits = "Slack \u{1F600} general";
    let store = FakeStore::new(vec![ActivityRow {
        active_title: Some(fits.to_owned()),
        ..row("r1")
    }]);

    flush_activity(&api, &store, &nothing_pending)
        .await
        .unwrap();

    assert_eq!(sample_body(&server)["samples"][0]["activeTitle"], fits);
}

#[test]
fn cap_counts_utf16_units_not_characters_or_bytes() {
    assert_eq!(cap(None, 3), None);
    assert_eq!(cap(Some("abc"), 3).as_deref(), Some("abc"));
    assert_eq!(cap(Some("abcd"), 3).as_deref(), Some("abc"));
    // 'é' is 2 bytes but 1 unit; the emoji is 2 units. Cut at 2 lands inside it.
    assert_eq!(cap(Some("é😀"), 2).as_deref(), Some("é"));
    assert_eq!(cap(Some("é😀"), 3).as_deref(), Some("é😀"));
}

#[tokio::test]
async fn the_wire_body_is_json_stringify_text_with_iso_bucket_start() {
    let server = MockServer::start(accepts(r#"{"accepted":1}"#)).await;
    let api = api_for(&server);
    let store = FakeStore::new(vec![ActivityRow {
        bucket_start: 1_791_133_380_000.0,
        iki_cv: Some(0.5),
        ..row("r1")
    }]);

    flush_activity(&api, &store, &nothing_pending)
        .await
        .unwrap();

    assert_eq!(
        server.requests()[0].body,
        r#"{"samples":[{"id":"r1","timeEntryId":"t","bucketStart":"2026-10-04T17:03:00.000Z","keystrokes":1,"clicks":1,"mouseDistancePx":0,"scrollEvents":0,"ikiCv":0.5,"moveSpeedCv":0,"pathStraightness":0,"activeApp":"app","activeAppBundle":null,"activeTitle":null,"activeUrl":null}]}"#
    );
}

// ---------------- ActivitySyncDrain (syncDrain.test.ts) ----------------

#[derive(Default)]
struct Deps {
    flushes: Mutex<VecDeque<Result<usize, String>>>,
    flush_calls: AtomicUsize,
    order: Mutex<Vec<&'static str>>,
    prerequisite: Mutex<Option<Result<(), String>>>,
    now: AtomicI64,
    gate: Mutex<Option<tokio::sync::oneshot::Receiver<usize>>>,
}

impl Deps {
    fn scripted(values: Vec<Result<usize, String>>) -> Arc<Self> {
        Arc::new(Self {
            flushes: Mutex::new(values.into()),
            ..Self::default()
        })
    }
}

impl ActivityDrainDeps for Deps {
    async fn before_flush(&self) -> Result<(), String> {
        self.order.lock().unwrap().push("timer");
        self.prerequisite.lock().unwrap().clone().unwrap_or(Ok(()))
    }
    async fn flush(&self) -> Result<usize, String> {
        self.flush_calls.fetch_add(1, Ordering::SeqCst);
        self.order.lock().unwrap().push("activity");
        let gate = self.gate.lock().unwrap().take();
        if let Some(gate) = gate {
            return Ok(gate.await.unwrap_or(0));
        }
        self.flushes.lock().unwrap().pop_front().unwrap_or(Ok(0))
    }
    fn now_ms(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
}

#[tokio::test(start_paused = true)]
async fn runs_periodic_drains() {
    let deps = Deps::scripted(vec![Ok(0)]);
    let drain = ActivitySyncDrain::new(
        Arc::clone(&deps),
        DrainConfig {
            interval_ms: 1000,
            ..DrainConfig::default()
        },
    );

    drain.start();
    tokio::time::sleep(Duration::from_secs(1)).await;
    tokio::task::yield_now().await;

    assert_eq!(deps.flush_calls.load(Ordering::SeqCst), 1);
    drain.stop();
}

#[tokio::test]
async fn drains_multiple_batches_until_empty() {
    let deps = Deps::scripted(vec![Ok(200), Ok(50), Ok(0)]);
    let drain = ActivitySyncDrain::new(Arc::clone(&deps), DrainConfig::default());

    let result = drain.drain_now(ActivityDrainReason::Boot).await;

    assert_eq!(
        result,
        DrainResult {
            batches: 2,
            samples: 250,
            skipped: None
        }
    );
    assert_eq!(deps.flush_calls.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn waits_for_timer_sync_before_uploading_dependent_activity() {
    let deps = Deps::scripted(vec![Ok(0)]);
    let drain = ActivitySyncDrain::new(Arc::clone(&deps), DrainConfig::default());

    drain.drain_now(ActivityDrainReason::Sample).await;

    assert_eq!(*deps.order.lock().unwrap(), ["timer", "activity"]);
}

#[tokio::test]
async fn does_not_upload_activity_when_its_sync_prerequisite_fails() {
    let deps = Deps::scripted(vec![Ok(0)]);
    *deps.prerequisite.lock().unwrap() = Some(Err("timer store unavailable".to_owned()));
    let drain = ActivitySyncDrain::new(Arc::clone(&deps), DrainConfig::default());

    let result = drain.drain_now(ActivityDrainReason::Wake).await;

    assert_eq!(
        result,
        DrainResult {
            batches: 0,
            samples: 0,
            skipped: None
        }
    );
    assert_eq!(deps.flush_calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn stops_on_the_first_failed_batch_and_leaves_later_rows_for_a_retry() {
    let deps = Deps::scripted(vec![Ok(200), Err("network down".to_owned()), Ok(0)]);
    let drain = ActivitySyncDrain::new(Arc::clone(&deps), DrainConfig::default());

    let result = drain.drain_now(ActivityDrainReason::Auth).await;

    assert_eq!(
        result,
        DrainResult {
            batches: 1,
            samples: 200,
            skipped: None
        }
    );
    assert_eq!(deps.flush_calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn does_not_run_overlapping_drains() {
    let deps = Deps::scripted(vec![]);
    let (release, gate) = tokio::sync::oneshot::channel();
    *deps.gate.lock().unwrap() = Some(gate);
    let drain = ActivitySyncDrain::new(Arc::clone(&deps), DrainConfig::default());

    let first = drain.drain_now(ActivityDrainReason::Sample);
    let second = drain.drain_now(ActivityDrainReason::Wake);
    tokio::task::yield_now().await;

    assert!(second.ptr_eq(&first), "the same in-flight promise");
    assert_eq!(deps.flush_calls.load(Ordering::SeqCst), 1);
    release.send(0).unwrap();
    first.await;
}

#[tokio::test]
async fn throttles_heartbeat_triggered_drains() {
    let deps = Deps::scripted(vec![]);
    deps.now.store(120_000, Ordering::SeqCst);
    let drain = ActivitySyncDrain::new(
        Arc::clone(&deps),
        DrainConfig {
            heartbeat_throttle_ms: 60_000,
            ..DrainConfig::default()
        },
    );

    drain.drain_now(ActivityDrainReason::Heartbeat).await;
    let throttled = drain.drain_now(ActivityDrainReason::Heartbeat).await;
    deps.now.fetch_add(60_000, Ordering::SeqCst);
    drain.drain_now(ActivityDrainReason::Heartbeat).await;

    assert_eq!(
        throttled,
        DrainResult {
            batches: 0,
            samples: 0,
            skipped: Some(Skipped::HeartbeatThrottle)
        }
    );
    assert_eq!(deps.flush_calls.load(Ordering::SeqCst), 2);
}
