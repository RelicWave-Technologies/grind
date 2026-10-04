//! `flushActivity` parity: for random backlogs (unicode, emoji across the UTF-16
//! caps, fractional numbers, 500-row backlogs, parents still pending) the Rust
//! sender must pick the same rows, split at the same byte, mark the same ids
//! and send the same bytes as the REAL `activity/sync.ts`.
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

use serde_json::Value;
use support::{MockServer, Reply, f, fixture, opt_f, opt_s, s, tokens};
use timo_sync::ApiClient;
use timo_sync::activity_sync::{ActivityOutbox, ActivityRow, FlushError, flush_activity};
use timo_sync::tokens::MemoryTokenStore;

fn row(v: &Value) -> ActivityRow {
    ActivityRow {
        id: s(&v["id"]),
        time_entry_id: opt_s(&v["timeEntryId"]),
        bucket_start: f(&v["bucketStart"]),
        keystrokes: f(&v["keystrokes"]),
        clicks: f(&v["clicks"]),
        mouse_distance_px: f(&v["mouseDistancePx"]),
        scroll_events: f(&v["scrollEvents"]),
        iki_cv: opt_f(&v["ikiCv"]),
        move_speed_cv: opt_f(&v["moveSpeedCv"]),
        path_straightness: opt_f(&v["pathStraightness"]),
        active_app: opt_s(&v["activeApp"]),
        active_app_bundle: opt_s(&v["activeAppBundle"]),
        active_title: opt_s(&v["activeTitle"]),
        active_url: opt_s(&v["activeUrl"]),
    }
}

struct Store {
    rows: Vec<ActivityRow>,
    marked: Mutex<Vec<String>>,
}

impl ActivityOutbox for Store {
    fn unsynced(&self, limit: usize) -> Result<Vec<ActivityRow>, String> {
        Ok(self.rows.iter().take(limit).cloned().collect())
    }
    fn mark_synced(&self, ids: &[String]) -> Result<(), String> {
        self.marked.lock().unwrap().extend_from_slice(ids);
        Ok(())
    }
}

#[tokio::test]
async fn flush_activity_matches_the_typescript_batches_and_bytes() {
    let server = MockServer::start(|_, _| Reply::json(200, r#"{"accepted":1,"detached":0}"#)).await;
    let api = ApiClient::new(
        &server.base,
        Arc::new(MemoryTokenStore::new(Some(tokens("a", "r")))),
    )
    .unwrap();
    let cases = fixture("activitySync", "flush_activity");
    let (mut errors, mut splits, mut capped) = (0, 0, 0);
    for (i, case) in cases.iter().enumerate() {
        let rows: Vec<ActivityRow> = case.input["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(row)
            .collect();
        let total = rows.len();
        let pending: Vec<String> = case.input["pending"]
            .as_array()
            .unwrap()
            .iter()
            .map(s)
            .collect();
        let store = Store {
            rows,
            marked: Mutex::default(),
        };
        let before = server.count();

        let got = flush_activity(&api, &store, &|id: &str| pending.iter().any(|p| p == id)).await;

        let marked = store.marked.lock().unwrap().clone();
        let want_marked: Vec<String> = case.output["marked"]
            .as_array()
            .unwrap()
            .iter()
            .map(s)
            .collect();
        assert_eq!(marked, want_marked, "case {i}: marked ids");
        if let Some(message) = case.output.get("error") {
            errors += 1;
            let err = got.unwrap_err();
            let FlushError::Api(api) = err else {
                unreachable!()
            };
            assert_eq!(api.message(), s(message), "case {i}");
            assert_eq!(
                server.count(),
                before,
                "case {i}: nothing is sent when a row cannot be serialised"
            );
            continue;
        }
        assert_eq!(
            got.unwrap(),
            usize::try_from(case.output["sent"].as_u64().unwrap()).unwrap(),
            "case {i}: rows sent"
        );
        let want_body = case.output["bodyText"].as_str();
        let sent_body =
            (server.count() > before).then(|| server.requests().last().unwrap().body.clone());
        assert_eq!(sent_body.as_deref(), want_body, "case {i}: body bytes");
        if marked.len() < total && !marked.is_empty() {
            splits += 1;
        }
        if total >= 500 {
            capped += 1;
        }
    }
    assert!(cases.len() >= 500);
    assert!(
        errors > 0 && splits > 0 && capped > 0,
        "errors {errors}, byte splits {splits}, 500-row backlogs {capped}"
    );
}
