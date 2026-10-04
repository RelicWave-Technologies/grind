//! The timer's HTTP transport (`HttpSyncClient`): paths, methods, bodies,
//! receipt parsing and error mapping, against a loopback server.
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

use support::{MockServer, Reply, tokens};
use timo_core::timer::error::SyncError;
use timo_core::timer::traits::SyncClient;
use timo_core::types::TimeEntry;
use timo_sync::timer_sync::{HttpSyncClient, fetch_today_ledger};
use timo_sync::tokens::MemoryTokenStore;
use timo_sync::{ApiClient, Platform};

fn entry(ended_at: Option<f64>) -> TimeEntry {
    serde_json::from_value(serde_json::json!({
        "id": "01ENTRY", "clientUuid": "01UUID", "userId": "u", "larkTaskGuid": "g1",
        "source": "AUTO", "revision": 3, "startedAt": 1_791_133_383_891.262_7, "endedAt": ended_at,
        "pauseReason": null, "closeReason": ended_at.map(|_| "AGENT"),
        "segments": [{"id": "01SEG", "kind": "WORK", "startedAt": 1_791_133_383_891.262_7, "endedAt": ended_at}]
    }))
    .expect("entry")
}

fn receipt() -> String {
    let hash = "a".repeat(64);
    format!(
        r#"{{"disposition":"APPLIED","acceptedRevision":3,"canonicalHash":"{hash}","canonicalEntry":{{"id":"01ENTRY","clientUuid":"01UUID","userId":"u","larkTaskGuid":"g1","source":"AUTO","trackingProtocolVersion":2,"revision":3,"lastProvenAt":null,"leaseExpiresAt":null,"closeReason":null,"serverFinalizedAt":null,"startedAt":"2026-10-04T17:03:03.891Z","endedAt":null,"notes":null,"segments":[{{"id":"01SEG","kind":"WORK","startedAt":"2026-10-04T17:03:03.891Z","endedAt":null}}]}},"serverTime":"2026-10-04T17:04:00.000Z","correction":null}}"#
    )
}

fn client(server: &MockServer) -> HttpSyncClient<MemoryTokenStore> {
    let store = Arc::new(MemoryTokenStore::new(Some(tokens("a", "r"))));
    let api = Arc::new(ApiClient::new(&server.base, store).unwrap());
    // serverAlignedNow() is read at serialisation time for an open entry.
    HttpSyncClient::new(
        api,
        "0.0.2".to_owned(),
        Platform::Darwin,
        Arc::new(|| 1_791_133_400_000.9),
    )
}

#[tokio::test]
async fn create_posts_the_lifecycle_body_with_a_server_clock_checkpoint_for_an_open_entry() {
    let server = MockServer::sequence(vec![Reply::json(200, &receipt())]).await;

    let got = client(&server).create(&entry(None)).await.unwrap();

    assert_eq!(got.accepted_revision.to_bits(), 3.0_f64.to_bits());
    let req = &server.requests()[0];
    assert_eq!(
        (req.method.as_str(), req.path.as_str()),
        ("POST", "/v1/time-entries")
    );
    assert_eq!(
        req.body,
        r#"{"trackingProtocolVersion":2,"revision":3,"observedAt":"2026-10-04T17:03:20.000Z","closeReason":null,"id":"01ENTRY","clientUuid":"01UUID","larkTaskGuid":"g1","source":"AUTO","startedAt":"2026-10-04T17:03:03.891Z","endedAt":null,"agentVersion":"0.0.2","platform":"darwin","segments":[{"id":"01SEG","kind":"WORK","startedAt":"2026-10-04T17:03:03.891Z","endedAt":null}]}"#
    );
}

#[tokio::test]
async fn sync_puts_to_the_entry_path_and_a_closed_entry_checkpoints_at_its_end() {
    let server = MockServer::sequence(vec![Reply::json(200, &receipt())]).await;

    client(&server)
        .sync(&entry(Some(1_791_133_500_000.4)))
        .await
        .unwrap();

    let req = &server.requests()[0];
    assert_eq!(
        (req.method.as_str(), req.path.as_str()),
        ("PUT", "/v1/time-entries/01ENTRY/sync")
    );
    assert_eq!(
        req.body,
        r#"{"trackingProtocolVersion":2,"revision":3,"observedAt":"2026-10-04T17:05:00.000Z","closeReason":"AGENT","endedAt":"2026-10-04T17:05:00.000Z","segments":[{"id":"01SEG","kind":"WORK","startedAt":"2026-10-04T17:03:03.891Z","endedAt":"2026-10-04T17:05:00.000Z"}]}"#
    );
}

#[tokio::test]
async fn a_404_keeps_its_status_so_the_timer_can_recreate_the_entry() {
    let server = MockServer::sequence(vec![Reply::json(404, "missing")]).await;

    let err = client(&server).sync(&entry(None)).await.unwrap_err();

    assert!(err.is_not_found(), "{err}");
    assert_eq!(
        err.to_string(),
        "/v1/time-entries/01ENTRY/sync 404: missing"
    );
}

#[tokio::test]
async fn a_receipt_that_fails_the_schema_is_a_sync_failure() {
    let server = MockServer::sequence(vec![
        Reply::json(200, r#"{"disposition":"APPLIED"}"#),
        Reply::json(200, "[]"),
    ])
    .await;
    let c = client(&server);

    assert!(matches!(
        c.create(&entry(None)).await.unwrap_err(),
        SyncError::Other(_)
    ));
    assert!(matches!(
        c.create(&entry(None)).await.unwrap_err(),
        SyncError::Other(_)
    ));
}

#[tokio::test]
async fn the_body_is_built_when_called_not_when_awaited() {
    // `lifecycle()` samples the clock inside the async function's first
    // synchronous stretch: two calls made before either is awaited read it in order.
    let server = MockServer::sequence(vec![
        Reply::json(200, &receipt()),
        Reply::json(200, &receipt()),
    ])
    .await;
    let ticks = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = Arc::clone(&ticks);
    let store = Arc::new(MemoryTokenStore::new(Some(tokens("a", "r"))));
    let api = Arc::new(ApiClient::new(&server.base, store).unwrap());
    let c = HttpSyncClient::new(
        api,
        "0.0.2".to_owned(),
        Platform::Darwin,
        Arc::new(move || {
            f64::from(
                u32::try_from(counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst)).unwrap(),
            ) * 1000.0
                + 1_791_133_400_000.0
        }),
    );

    let (first, second) = (c.create(&entry(None)), c.create(&entry(None)));
    assert_eq!(ticks.load(std::sync::atomic::Ordering::SeqCst), 2);
    first.await.unwrap();
    second.await.unwrap();
    let observed: Vec<String> = server
        .requests()
        .iter()
        .map(|r| r.body.split("\"observedAt\":\"").nth(1).unwrap_or_default()[..24].to_owned())
        .collect();
    assert!(
        observed.contains(&"2026-10-04T17:03:20.000Z".to_owned()),
        "{observed:?}"
    );
    assert!(
        observed.contains(&"2026-10-04T17:03:21.000Z".to_owned()),
        "{observed:?}"
    );
}

#[tokio::test]
async fn the_today_ledger_read_returns_the_body_or_the_error_text() {
    let server = MockServer::sequence(vec![
        Reply::json(200, r#"{"complete":true}"#),
        Reply::json(500, "no"),
    ])
    .await;
    let store = Arc::new(MemoryTokenStore::new(Some(tokens("a", "r"))));
    let api = ApiClient::new(&server.base, store).unwrap();

    let ok = fetch_today_ledger(&api, "/v1/agent/today-ledger?from=a&to=b")
        .await
        .unwrap();
    let err = fetch_today_ledger(&api, "/v1/agent/today-ledger?from=a&to=b")
        .await
        .unwrap_err();

    assert_eq!(ok["complete"], true);
    assert_eq!(err, "HttpError: /v1/agent/today-ledger?from=a&to=b 500: no");
    assert_eq!(
        server.requests()[0].path,
        "/v1/agent/today-ledger?from=a&to=b"
    );
}
