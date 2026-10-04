//! Database compatibility: an `agent.db` written by the LEGACY `SqliteEntryStore`
//! (fractional timestamps, several owners, unowned legacy rows, meta, a server
//! snapshot) is opened by the Rust store, which must answer every read and perform
//! every write exactly as the legacy store did (`parity/src/scenarios/timerCompatBuild.ts`).
//! The database is stored as base64 in the fixture and copied to a scratch file.

#![allow(
    clippy::unwrap_used,
    clippy::too_many_lines,
    reason = "tests unwrap; `run` is a flat match with one arm per op of the compat script"
)]

mod timer_support;

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use timer_support::dump::{dump_entries, dump_meta};
use timer_support::members::{array_items, minify, object_members};
use timer_support::records::text;
use timo_core::timer::traits::{EntryStore, ServerLedgerCache};
use timo_core::timer::types::{
    Acknowledgement, DayWindow, EntryMatch, EntrySyncState, PendingEntrySyncState,
    ReadRecoveryNotice, TimerAwayState, TimerExitIntent, TimerOwner, TimerRecoveryNotice,
    UnsyncedEntry,
};
use timo_core::types::TimeEntry;
use timo_store::timer::{SqliteEntryStore, SqliteTodayLedgerStore, shared};

#[derive(Deserialize)]
struct Pair {
    id: String,
    #[serde(rename = "clientUuid")]
    client_uuid: String,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Op {
    Bind {
        owner: TimerOwner,
    },
    GetOpen,
    GetUnsynced,
    HasUnsynced,
    IsPendingCreate {
        id: String,
    },
    ListRecent {
        limit: f64,
    },
    ListSince {
        since: f64,
    },
    ListLedgerEntries {
        since: f64,
    },
    GetLiveness,
    GetExitIntent,
    GetAwayState,
    GetRecoveryNotice,
    CacheList {
        start: f64,
        end: f64,
        now: f64,
    },
    Upsert {
        entry: TimeEntry,
        #[serde(rename = "syncState")]
        sync_state: Option<PendingEntrySyncState>,
    },
    MarkSynced {
        id: String,
        entry: TimeEntry,
        revision: f64,
        hash: String,
    },
    MarkPendingCreate {
        id: String,
        entry: TimeEntry,
    },
    SetLiveness {
        ts: f64,
    },
    ClearExitIntent,
    SetRecoveryNotice {
        value: TimerRecoveryNotice,
    },
    ClearAwayState,
    ClearRecoveryNotice,
    ClaimUnowned {
        owner: TimerOwner,
    },
    ClaimMatched {
        owner: TimerOwner,
        pairs: Vec<Pair>,
    },
    SwitchEntry {
        closed: TimeEntry,
        next: TimeEntry,
    },
    ReadEntry {
        id: String,
    },
    MutateFromRead {
        id: String,
    },
    MarkFromRead {
        #[serde(rename = "fn")]
        fn_name: String,
        id: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LedgerOut {
    entry: TimeEntry,
    sync_state: EntrySyncState,
    acknowledged_revision: Option<f64>,
    acknowledged_hash: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CacheOut {
    entry: TimeEntry,
    canonical_payload: String,
    canonical_hash: String,
}

#[derive(Serialize)]
#[serde(untagged)]
enum V {
    Null,
    Bool(bool),
    Num(f64),
    NumOrNull(Option<f64>),
    Entry(Option<TimeEntry>),
    Entries(Vec<TimeEntry>),
    Unsynced(Vec<UnsyncedEntry>),
    Ledger(Vec<LedgerOut>),
    Exit(Option<TimerExitIntent>),
    Away(Option<TimerAwayState>),
    Notice(Option<ReadRecoveryNotice>),
    Cache(Vec<CacheOut>),
    State(PendingEntrySyncState),
    Pair((PendingEntrySyncState, PendingEntrySyncState)),
}

#[derive(Serialize)]
struct Ok_ {
    ok: V,
}

#[derive(Serialize)]
struct Err_ {
    error: String,
}

/// The entry as the store hands it back: what the service keeps and later passes to `mark*`.
fn read_back(store: &SqliteEntryStore, id: &str) -> Result<TimeEntry, String> {
    let rows = store.list_ledger_entries(0.0).map_err(|e| e.to_string())?;
    rows.into_iter()
        .map(|row| row.entry)
        .find(|entry| entry.id == id)
        .ok_or_else(|| format!("no row {id}"))
}

fn count(n: usize) -> V {
    V::Num(f64::from(u32::try_from(n).unwrap()))
}

fn run(
    store: &mut SqliteEntryStore,
    cache: &SqliteTodayLedgerStore,
    op: &Op,
    me: &TimerOwner,
) -> Result<V, String> {
    let e = |e: timo_core::timer::TimerError| e.to_string();
    Ok(match op {
        Op::Bind { owner } => {
            store.bind_owner(Some(owner.clone()));
            V::Null
        }
        Op::GetOpen => V::Entry(store.get_open().map_err(e)?),
        Op::GetUnsynced => V::Unsynced(store.get_unsynced().map_err(e)?),
        Op::HasUnsynced => V::Bool(store.has_unsynced().map_err(e)?),
        Op::IsPendingCreate { id } => V::Bool(store.is_pending_create(id).map_err(e)?),
        Op::ListRecent { limit } => V::Entries(store.list_recent(*limit).map_err(e)?),
        Op::ListSince { since } => V::Entries(store.list_since(*since).map_err(e)?),
        Op::ListLedgerEntries { since } => V::Ledger(
            store
                .list_ledger_entries(*since)
                .map_err(e)?
                .into_iter()
                .map(|l| LedgerOut {
                    entry: l.entry,
                    sync_state: l.sync_state,
                    acknowledged_revision: l.acknowledged_revision,
                    acknowledged_hash: l.acknowledged_hash,
                })
                .collect(),
        ),
        Op::GetLiveness => V::NumOrNull(store.get_liveness().map_err(e)?),
        Op::GetExitIntent => V::Exit(store.get_exit_intent().map_err(e)?),
        Op::GetAwayState => V::Away(store.get_away_state().map_err(e)?),
        Op::GetRecoveryNotice => V::Notice(store.get_recovery_notice().map_err(e)?),
        Op::CacheList { start, end, now } => V::Cache(
            cache
                .list(
                    me,
                    DayWindow {
                        start: *start,
                        end: *end,
                    },
                    *now,
                )
                .map_err(e)?
                .into_iter()
                .map(|s| CacheOut {
                    entry: s.entry,
                    canonical_payload: s.canonical_payload,
                    canonical_hash: s.canonical_hash,
                })
                .collect(),
        ),
        Op::Upsert { entry, sync_state } => V::State(store.upsert(entry, *sync_state).map_err(e)?),
        Op::MarkSynced {
            id,
            entry,
            revision,
            hash,
        } => V::Bool(
            store
                .mark_synced(
                    id,
                    entry,
                    &Acknowledgement {
                        revision: *revision,
                        hash: hash.clone(),
                    },
                )
                .map_err(e)?,
        ),
        Op::MarkPendingCreate { id, entry } => {
            V::Bool(store.mark_pending_create(id, entry).map_err(e)?)
        }
        Op::SetLiveness { ts } => {
            store.set_liveness(*ts).map_err(e)?;
            V::Null
        }
        Op::ClearExitIntent => {
            store.clear_exit_intent().map_err(e)?;
            V::Null
        }
        Op::SetRecoveryNotice { value } => {
            store.set_recovery_notice(value).map_err(e)?;
            V::Null
        }
        Op::ClearAwayState => {
            store.clear_away_state().map_err(e)?;
            V::Null
        }
        Op::ClearRecoveryNotice => {
            store.clear_recovery_notice().map_err(e)?;
            V::Null
        }
        Op::ClaimUnowned { owner } => count(store.claim_unowned_entries(owner).map_err(e)?),
        Op::ClaimMatched { owner, pairs } => {
            let matches: Vec<EntryMatch> = pairs
                .iter()
                .map(|p| EntryMatch {
                    id: p.id.clone(),
                    client_uuid: p.client_uuid.clone(),
                })
                .collect();
            count(
                store
                    .claim_server_matched_entries(owner, &matches)
                    .map_err(e)?,
            )
        }
        Op::SwitchEntry { closed, next } => V::Pair(store.switch_entry(closed, next).map_err(e)?),
        Op::ReadEntry { id } => V::Entry(Some(read_back(store, id)?)),
        Op::MutateFromRead { id } => {
            let mut entry = read_back(store, id)?;
            entry.revision = timo_core::js::number::add(entry.revision, 1.0);
            V::State(store.upsert(&entry, None).map_err(e)?)
        }
        Op::MarkFromRead { fn_name, id } => {
            let entry = read_back(store, id)?;
            V::Bool(match fn_name.as_str() {
                "markSynced" => {
                    let ack = Acknowledgement {
                        revision: entry.revision,
                        hash: "ab".repeat(32),
                    };
                    store.mark_synced(id, &entry, &ack).map_err(e)?
                }
                "markCreated" => store.mark_created(id, &entry).map_err(e)?,
                _ => store.mark_pending_create(id, &entry).map_err(e)?,
            })
        }
    })
}

#[test]
fn rust_reads_and_writes_a_database_the_legacy_store_wrote() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/timer/compat.json");
    let fixture = minify(&fs::read_to_string(&path).unwrap());
    let case_members = object_members(
        &object_members(
            &array_items(
                &object_members(&fixture)
                    .iter()
                    .find(|(k, _)| k == "cases")
                    .unwrap()
                    .1,
            )[0],
        )
        .iter()
        .find(|(k, _)| k == "output")
        .unwrap()
        .1,
    );
    let db_base64: String = serde_json::from_str(
        &case_members
            .iter()
            .find(|(k, _)| k == "dbBase64")
            .unwrap()
            .1,
    )
    .unwrap();
    let steps = array_items(&case_members.iter().find(|(k, _)| k == "steps").unwrap().1);
    let case = array_items(
        &object_members(&fixture)
            .iter()
            .find(|(k, _)| k == "cases")
            .unwrap()
            .1,
    );
    let input = object_members(
        &object_members(&case[0])
            .iter()
            .find(|(k, _)| k == "input")
            .unwrap()
            .1,
    );
    let script: Vec<Op> =
        serde_json::from_str(&input.iter().find(|(k, _)| k == "script").unwrap().1).unwrap();
    assert_eq!(script.len(), steps.len());

    // A scratch copy: the Rust store switches the file back to WAL and writes to it.
    let dir = std::env::temp_dir().join(format!("timo-compat-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let file = dir.join("agent.db");
    fs::write(&file, STANDARD.decode(db_base64).unwrap()).unwrap();
    let db = shared(Connection::open(&file).unwrap());
    let mut store = SqliteEntryStore::new(db.clone()).unwrap();
    let cache = SqliteTodayLedgerStore::new(db.clone(), Arc::new(|| 0.0)).unwrap();
    let me = TimerOwner {
        user_id: "user-1".into(),
        workspace_id: "ws-1".into(),
    };

    for (i, (op, step)) in script.iter().zip(&steps).enumerate() {
        let result = match run(&mut store, &cache, op, &me) {
            Ok(v) => text(&Ok_ { ok: v }),
            Err(error) => text(&Err_ { error }),
        };
        let conn = db.lock().unwrap();
        let actual = [
            ("result", result),
            ("entries", text(&dump_entries(&conn))),
            ("meta", text(&dump_meta(&conn))),
        ];
        drop(conn);
        let expected = object_members(step);
        for ((key, got), (want_key, want)) in actual.iter().zip(&expected) {
            assert_eq!(key, want_key);
            assert_eq!(got, want, "step {i} member `{key}` differs");
        }
    }
    drop((store, cache, db));
    fs::remove_dir_all(&dir).unwrap();
}
