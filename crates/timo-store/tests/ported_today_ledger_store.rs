//! 1:1 port of `legacy/agent/src/main/services/timer/todayLedgerStore.test.ts`.
#![allow(clippy::unwrap_used, reason = "tests unwrap")]

use std::sync::Arc;

use serde_json::{Value, json};
use timo_core::js::iso::to_iso_string;
use timo_core::timer::dto::TodayLedgerResponse;
use timo_core::timer::traits::ServerLedgerCache;
use timo_core::timer::types::{DayWindow, TimerOwner};
use timo_core::types::TimeEntrySource;
use timo_store::timer::{SharedDb, SqliteTodayLedgerStore, open_in_memory};

fn owner() -> TimerOwner {
    TimerOwner {
        user_id: "user-1".into(),
        workspace_id: "workspace-1".into(),
    }
}

const WINDOW: DayWindow = DayWindow {
    start: 0.0,
    end: 86_400_000.0,
};

fn iso(ms: f64) -> String {
    to_iso_string(ms).unwrap()
}

/// `snapshot(overrides)`.
fn snapshot(entries: Option<Value>, approved_manual: Option<Value>) -> TodayLedgerResponse {
    let mut value = json!({
        "complete": true,
        "serverTime": iso(10_000.0),
        "workspaceTimezone": "Asia/Kolkata",
        "entries": entries.unwrap_or_else(|| json!([server_entry("user-1")])),
        "effectiveEntries": [{
            "entryId": "server-entry",
            "endedAt": iso(5_000.0),
            "segments": [{ "segmentId": "server-segment", "endedAt": iso(5_000.0) }]
        }]
    });
    if let Some(manual) = approved_manual {
        value
            .as_object_mut()
            .unwrap()
            .insert("approvedManualEntries".to_owned(), manual);
    }
    serde_json::from_value(value).unwrap()
}

fn server_entry(user: &str) -> Value {
    json!({
        "id": "server-entry",
        "clientUuid": "server-client",
        "userId": user,
        "larkTaskGuid": null,
        "source": "AUTO",
        "trackingProtocolVersion": 2,
        "revision": 2,
        "lastProvenAt": iso(5_000.0),
        "leaseExpiresAt": iso(8_000.0),
        "closeReason": null,
        "serverFinalizedAt": null,
        "startedAt": iso(1_000.0),
        "endedAt": null,
        "notes": null,
        "segments": [{ "id": "server-segment", "kind": "WORK", "startedAt": iso(1_000.0), "endedAt": null }]
    })
}

fn approved_manual_entry() -> Value {
    json!({
        "id": "manual-entry",
        "clientUuid": "manual-client",
        "userId": "user-1",
        "larkTaskGuid": "manual-task",
        "source": "MANUAL",
        "trackingProtocolVersion": null,
        "revision": null,
        "lastProvenAt": null,
        "leaseExpiresAt": null,
        "closeReason": null,
        "serverFinalizedAt": null,
        "startedAt": iso(20_000.0),
        "endedAt": iso(30_000.0),
        "notes": null,
        "segments": [{ "id": "manual-segment", "kind": "WORK", "startedAt": iso(20_000.0), "endedAt": iso(30_000.0) }]
    })
}

fn store(db: &SharedDb) -> SqliteTodayLedgerStore {
    SqliteTodayLedgerStore::new(db.clone(), Arc::new(|| 0.0)).unwrap()
}

mod sqlite_today_ledger_store {
    use super::*;

    #[test]
    fn caches_approved_manual_rows_as_closed_server_only_ledger_evidence() {
        let db = open_in_memory().unwrap();
        let store = store(&db);
        store
            .replace_snapshot(
                &owner(),
                WINDOW,
                &snapshot(None, Some(json!([approved_manual_entry()]))),
            )
            .unwrap();

        let rows = store.list(&owner(), WINDOW, 40_000.0).unwrap();
        assert_eq!(rows.len(), 2);
        let manual = rows
            .iter()
            .find(|row| row.entry.id == "manual-entry")
            .unwrap();
        assert_eq!(manual.entry.source, TimeEntrySource::Manual);
        assert_eq!(manual.entry.ended_at, Some(30_000.0));
    }

    #[test]
    fn caps_an_expired_open_lease_at_the_last_proven_boundary() {
        let db = open_in_memory().unwrap();
        let store = store(&db);
        store
            .replace_snapshot(&owner(), WINDOW, &snapshot(None, None))
            .unwrap();
        let rows = store.list(&owner(), WINDOW, 20_000.0).unwrap();
        assert_eq!(rows[0].entry.ended_at, Some(5_000.0));
        assert_eq!(rows[0].entry.segments[0].ended_at, Some(5_000.0));
    }

    #[test]
    fn keeps_the_previous_complete_snapshot_when_a_replacement_fails_validation() {
        let db = open_in_memory().unwrap();
        let store = store(&db);
        store
            .replace_snapshot(&owner(), WINDOW, &snapshot(None, None))
            .unwrap();
        let invalid = snapshot(Some(json!([server_entry("another-user")])), None);
        let err = store
            .replace_snapshot(&owner(), WINDOW, &invalid)
            .unwrap_err();
        assert!(err.to_string().contains("today_ledger_owner_mismatch"));
        assert_eq!(store.list(&owner(), WINDOW, 20_000.0).unwrap().len(), 1);
    }

    #[test]
    fn does_not_expose_cached_rows_across_owners() {
        let db = open_in_memory().unwrap();
        let store = store(&db);
        store
            .replace_snapshot(&owner(), WINDOW, &snapshot(None, None))
            .unwrap();
        let other = TimerOwner {
            user_id: "user-2".into(),
            workspace_id: owner().workspace_id,
        };
        assert!(store.list(&other, WINDOW, 20_000.0).unwrap().is_empty());
    }

    #[test]
    fn falls_back_to_local_only_when_the_advisory_cache_is_corrupt() {
        let db = open_in_memory().unwrap();
        let store = store(&db);
        store
            .replace_snapshot(&owner(), WINDOW, &snapshot(None, None))
            .unwrap();
        db.lock()
            .unwrap()
            .execute(
                "UPDATE server_entry_cache SET canonical_json = 'not-json'",
                [],
            )
            .unwrap();

        assert!(store.list(&owner(), WINDOW, 20_000.0).unwrap().is_empty());
    }
}
