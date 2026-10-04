//! 1:1 port of `legacy/agent/src/main/services/timer/sqliteStore.test.ts`.
#![allow(
    clippy::float_arithmetic,
    clippy::float_cmp,
    clippy::unwrap_used,
    reason = "tests unwrap and build timestamps with the same arithmetic as the TypeScript"
)]

use rusqlite::params;
use timo_core::js::ser::to_string;
use timo_core::timer::traits::EntryStore;
use timo_core::timer::types::{
    Acknowledgement, EntryMatch, EntrySyncState, PendingEntrySyncState, ReadRecoveryNotice,
    TimerAwayReason, TimerAwayState, TimerExitIntent, TimerExitReason, TimerOwner,
    TimerRecoveryNotice, TimerRecoveryReason,
};
use timo_core::types::{TimeEntry, TimeEntrySource};
use timo_core::{CreateArgs, close_time_entry, create_time_entry};
use timo_store::timer::{SharedDb, SqliteEntryStore, open_in_memory};

const T0: f64 = 1_700_000_000_000.0;
const MIN: f64 = 60_000.0;

fn entry(id: &str) -> TimeEntry {
    create_time_entry(&CreateArgs {
        id: id.to_owned(),
        client_uuid: format!("client_{id}"),
        user_id: "user-1".to_owned(),
        lark_task_guid: None,
        source: Some(TimeEntrySource::Auto),
        started_at: T0,
        segment_id: format!("segment_{id}"),
    })
}

fn owner(user: &str) -> TimerOwner {
    TimerOwner {
        user_id: user.to_owned(),
        workspace_id: "workspace-1".to_owned(),
    }
}

fn old_schema(db: &SharedDb) {
    db.lock()
        .unwrap()
        .execute_batch(
            "CREATE TABLE local_entries (
      id          TEXT PRIMARY KEY,
      client_uuid TEXT NOT NULL UNIQUE,
      ended_at    INTEGER,
      synced      INTEGER NOT NULL DEFAULT 0,
      json        TEXT NOT NULL
    );
    CREATE TABLE timer_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );",
        )
        .unwrap();
}

fn insert_old(db: &SharedDb, e: &TimeEntry, synced: i64) {
    db.lock()
        .unwrap()
        .execute(
            "INSERT INTO local_entries (id, client_uuid, ended_at, synced, json) VALUES (?, ?, ?, ?, ?)",
            params![e.id, e.client_uuid, e.ended_at, synced, to_string(e).unwrap()],
        )
        .unwrap();
}

fn owned_store(db: &SharedDb) -> SqliteEntryStore {
    let mut store = SqliteEntryStore::new(db.clone()).unwrap();
    store.bind_owner(Some(owner("user-1")));
    store
}

fn ack(e: &TimeEntry) -> Acknowledgement {
    Acknowledgement {
        revision: e.revision,
        hash: "a".repeat(64),
    }
}

mod sqlite_entry_store_sync_state {
    use super::*;

    #[test]
    fn stores_new_rows_as_pending_create_and_marks_synced_rows_clean() {
        let db = open_in_memory().unwrap();
        let mut store = owned_store(&db);
        let e = entry("entry_1");

        assert_eq!(
            store.upsert(&e, None).unwrap(),
            PendingEntrySyncState::PendingCreate
        );
        assert!(store.is_pending_create(&e.id).unwrap());
        let unsynced = store.get_unsynced().unwrap();
        assert_eq!(unsynced.len(), 1);
        assert_eq!(unsynced[0].sync_state, PendingEntrySyncState::PendingCreate);

        store.mark_synced(&e.id, &e, &ack(&e)).unwrap();
        assert!(!store.is_pending_create(&e.id).unwrap());
        assert_eq!(store.get_unsynced().unwrap().len(), 0);
    }

    #[test]
    fn does_not_mark_synced_when_the_local_snapshot_changed_during_sync() {
        let db = open_in_memory().unwrap();
        let mut store = owned_store(&db);
        let e = entry("entry_1");
        store
            .upsert(&e, Some(PendingEntrySyncState::PendingUpdate))
            .unwrap();
        let changed = close_time_entry(&e, T0 + 5.0 * MIN).unwrap();
        store.upsert(&changed, None).unwrap();

        assert!(!store.mark_synced(&e.id, &e, &ack(&e)).unwrap());
        let unsynced = store.get_unsynced().unwrap();
        assert_eq!(unsynced.len(), 1);
        assert_eq!(unsynced[0].sync_state, PendingEntrySyncState::PendingUpdate);
    }

    #[test]
    fn does_not_let_an_old_create_response_downgrade_a_newer_local_snapshot() {
        let db = open_in_memory().unwrap();
        let mut store = owned_store(&db);
        let original = entry("entry_1");
        store
            .upsert(&original, Some(PendingEntrySyncState::PendingCreate))
            .unwrap();
        let changed = close_time_entry(&original, T0 + 5.0 * MIN).unwrap();
        store.upsert(&changed, None).unwrap();

        assert!(!store.mark_created(&original.id, &original).unwrap());
        let unsynced = store.get_unsynced().unwrap();
        assert_eq!(unsynced.len(), 1);
        assert_eq!(unsynced[0].entry.revision, changed.revision);
        assert_eq!(unsynced[0].sync_state, PendingEntrySyncState::PendingCreate);
    }

    #[test]
    fn dirty_rows_preserve_pending_create_until_remote_creation_is_confirmed() {
        let db = open_in_memory().unwrap();
        let mut store = owned_store(&db);
        let e = entry("entry_1");
        store
            .upsert(&e, Some(PendingEntrySyncState::PendingCreate))
            .unwrap();

        let closed = close_time_entry(&e, T0 + 10.0 * MIN).unwrap();

        assert_eq!(
            store.upsert(&closed, None).unwrap(),
            PendingEntrySyncState::PendingCreate
        );
        let unsynced = store.get_unsynced().unwrap();
        assert_eq!(
            (unsynced.len(), unsynced[0].sync_state),
            (1, PendingEntrySyncState::PendingCreate)
        );
    }

    #[test]
    fn dirty_rows_become_pending_update_after_remote_creation_is_confirmed() {
        let db = open_in_memory().unwrap();
        let mut store = owned_store(&db);
        let e = entry("entry_1");
        store
            .upsert(&e, Some(PendingEntrySyncState::PendingCreate))
            .unwrap();
        store.mark_created(&e.id, &e).unwrap();

        let closed = close_time_entry(&e, T0 + 10.0 * MIN).unwrap();

        assert_eq!(
            store.upsert(&closed, None).unwrap(),
            PendingEntrySyncState::PendingUpdate
        );
        let unsynced = store.get_unsynced().unwrap();
        assert_eq!(
            (unsynced.len(), unsynced[0].sync_state),
            (1, PendingEntrySyncState::PendingUpdate)
        );
    }

    #[test]
    fn rolls_back_the_old_task_close_when_the_replacement_task_cannot_persist() {
        let db = open_in_memory().unwrap();
        let mut store = owned_store(&db);
        let old = entry("old-task");
        let collision = close_time_entry(&entry("existing-client"), T0 + MIN).unwrap();
        store.upsert(&old, None).unwrap();
        store.upsert(&collision, None).unwrap();

        let closed = close_time_entry(&old, T0 + 5.0 * MIN).unwrap();
        let replacement = TimeEntry {
            client_uuid: collision.client_uuid.clone(),
            ..entry("replacement")
        };
        assert!(store.switch_entry(&closed, &replacement).is_err());

        let recent = store.list_recent(10.0).unwrap();
        assert_eq!(
            recent
                .iter()
                .find(|item| item.id == old.id)
                .map(|item| item.ended_at),
            Some(None)
        );
        assert!(!recent.iter().any(|item| item.id == replacement.id));
    }

    #[test]
    fn migrates_old_synced_rows_to_synced() {
        let db = open_in_memory().unwrap();
        old_schema(&db);
        let e = entry("old_synced");
        insert_old(&db, &e, 1);

        let mut store = owned_store(&db);
        store.claim_unowned_entries(&owner("user-1")).unwrap();

        assert_eq!(store.get_unsynced().unwrap().len(), 0);
    }

    #[test]
    fn migrates_old_unsynced_rows_to_pending_create() {
        let db = open_in_memory().unwrap();
        old_schema(&db);
        let e = entry("old_unsynced");
        insert_old(&db, &e, 0);

        let mut store = owned_store(&db);
        store.claim_unowned_entries(&owner("user-1")).unwrap();

        let unsynced = store.get_unsynced().unwrap();
        assert_eq!(
            (unsynced.len(), unsynced[0].sync_state),
            (1, PendingEntrySyncState::PendingCreate)
        );
    }

    #[test]
    fn persists_exit_intent_away_state_and_recovery_notice_metadata() {
        let db = open_in_memory().unwrap();
        let mut store = owned_store(&db);

        let intent = TimerExitIntent {
            reason: TimerExitReason::Quit,
            entry_id: "entry_1".into(),
            observed_at: T0,
        };
        store.set_exit_intent(&intent).unwrap();
        assert_eq!(store.get_exit_intent().unwrap(), Some(intent));
        store.clear_exit_intent().unwrap();
        assert_eq!(store.get_exit_intent().unwrap(), None);

        let away = TimerAwayState {
            reason: TimerAwayReason::Suspend,
            entry_id: "entry_1".into(),
            away_started_at: T0 + MIN,
            observed_at: T0 + 2.0 * MIN,
        };
        store.set_away_state(&away).unwrap();
        assert_eq!(store.get_away_state().unwrap(), Some(away));
        store.clear_away_state().unwrap();
        assert_eq!(store.get_away_state().unwrap(), None);

        let notice = TimerRecoveryNotice {
            reason: TimerRecoveryReason::SleepStop,
            entry_id: "entry_1".into(),
            recovered_at: T0 + MIN,
            observed_at: T0 + 2.0 * MIN,
        };
        store.set_recovery_notice(&notice).unwrap();
        assert_eq!(
            store.get_recovery_notice().unwrap(),
            Some(ReadRecoveryNotice(notice))
        );
        store.clear_recovery_notice().unwrap();
        assert_eq!(store.get_recovery_notice().unwrap(), None);
    }

    #[test]
    fn uses_full_durability_and_never_exposes_one_owners_rows_to_another() {
        let db = open_in_memory().unwrap();
        let mut store = owned_store(&db);
        store.upsert(&entry("private-entry"), None).unwrap();
        let synchronous: i64 = db
            .lock()
            .unwrap()
            .query_row("PRAGMA synchronous", [], |r| r.get(0))
            .unwrap();
        assert_eq!(synchronous, 2);

        store.bind_owner(Some(owner("user-2")));
        assert!(store.get_open().unwrap().is_none());
        assert!(store.get_unsynced().unwrap().is_empty());

        store.bind_owner(Some(owner("user-1")));
        assert_eq!(
            store.get_open().unwrap().map(|e| e.id),
            Some("private-entry".to_owned())
        );
    }

    #[test]
    fn does_not_infer_ownership_for_ambiguous_legacy_rows_from_the_current_session() {
        let db = open_in_memory().unwrap();
        old_schema(&db);
        let legacy = TimeEntry {
            user_id: "self".into(),
            ..entry("legacy")
        };
        insert_old(&db, &legacy, 0);
        let mut store = owned_store(&db);
        assert!(store.get_unsynced().unwrap().is_empty());

        assert_eq!(store.claim_unowned_entries(&owner("user-1")).unwrap(), 0);
        assert!(store.get_unsynced().unwrap().is_empty());
    }

    #[test]
    fn claims_an_unowned_legacy_row_only_when_it_already_names_the_authenticated_user() {
        let db = open_in_memory().unwrap();
        old_schema(&db);
        let legacy = entry("owned-legacy");
        insert_old(&db, &legacy, 0);
        let mut store = owned_store(&db);

        assert_eq!(store.claim_unowned_entries(&owner("user-1")).unwrap(), 1);
        assert_eq!(store.get_unsynced().unwrap()[0].entry.user_id, "user-1");
    }

    #[test]
    fn claims_an_unknown_row_only_when_the_server_proves_its_exact_id_and_client_uuid() {
        let db = open_in_memory().unwrap();
        old_schema(&db);
        let legacy = TimeEntry {
            user_id: "self".into(),
            ..close_time_entry(&entry("server-proven"), T0 + MIN).unwrap()
        };
        insert_old(&db, &legacy, 0);
        let mut store = owned_store(&db);
        let me = owner("user-1");

        let wrong = [EntryMatch {
            id: legacy.id.clone(),
            client_uuid: "wrong-client".into(),
        }];
        assert_eq!(store.claim_server_matched_entries(&me, &wrong).unwrap(), 0);
        assert!(store.get_unsynced().unwrap().is_empty());
        let right = [EntryMatch {
            id: legacy.id.clone(),
            client_uuid: legacy.client_uuid.clone(),
        }];
        assert_eq!(store.claim_server_matched_entries(&me, &right).unwrap(), 1);
        assert_eq!(store.get_unsynced().unwrap()[0].entry.user_id, me.user_id);
        let _ = EntrySyncState::Synced; // the shared import list
    }
}
