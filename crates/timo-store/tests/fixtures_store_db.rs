//! The SQLite stores against golden output from the real TypeScript
//! (`parity/src/gen/store{Activity,Capture,Lark}.ts`): a seeded operation sequence per
//! case, replayed through the Rust store, and the whole database must come out the
//! same (rows, `typeof` of every value, schema text).
#![cfg(test)]

mod store_support;

use rusqlite::Connection;
use serde_json::Value;
use store_support::{Replay, assert_cases, num, replay, text, to_json};
use timo_store::activity_store::{ActivityRow, ActivityStore, PolicyFlags};
use timo_store::capture_store::{ScreenshotRow, ScreenshotStore};
use timo_store::lark_task_cache::{
    CachedLarkTask, LarkCacheError, LarkTaskCache, LarkTaskCacheOwner,
};

fn from<T: serde::de::DeserializeOwned>(value: &Value) -> T {
    serde_json::from_value(value.clone()).expect("op argument")
}

fn strings(value: &Value) -> Vec<String> {
    from(value)
}

fn optional_text<'a>(op: &'a Value, key: &str) -> Option<&'a str> {
    op.get(key).and_then(Value::as_str)
}

struct Activity(ActivityStore);

impl Replay for Activity {
    fn open(conn: Connection, _step: Option<&Value>, _case: &Value) -> rusqlite::Result<Self> {
        ActivityStore::new(conn).map(Self)
    }

    fn apply(&mut self, op: &Value) -> rusqlite::Result<Value> {
        let store = &mut self.0;
        Ok(match text(op, "op") {
            "insert" => store
                .insert(&from::<ActivityRow>(&op["row"]))
                .map(|()| Value::Null)?,
            "unsynced" => to_json(&store.unsynced(num(op, "limit"))?),
            "markSynced" => store
                .mark_synced(&strings(&op["ids"]))
                .map(|()| Value::Null)?,
            "scrub" => Value::from(store.scrub_active_fields(from::<PolicyFlags>(&op["policy"]))?),
            "countSince" => to_json(&store.count_since(num(op, "sinceMs"))?),
            "aggregate" => to_json(&store.aggregate(num(op, "fromMs"), num(op, "toMs"))?),
            other => panic!("unexpected op {other}"),
        })
    }
}

struct Capture(ScreenshotStore);

impl Replay for Capture {
    fn open(conn: Connection, step: Option<&Value>, case: &Value) -> rusqlite::Result<Self> {
        let now = num(step.unwrap_or(case), "now");
        ScreenshotStore::new(conn, now).map(Self)
    }

    fn apply(&mut self, op: &Value) -> rusqlite::Result<Value> {
        let store = &mut self.0;
        let id = || text(op, "id");
        Ok(match text(op, "op") {
            "insert" => store
                .insert(&from::<ScreenshotRow>(&op["row"]))
                .map(|()| Value::Null)?,
            "recent" => to_json(&store.recent(num(op, "limit"))?),
            "find" => to_json(&store.find(id())?),
            "countSince" => to_json(&store.count_since(num(op, "sinceMs"))?),
            "pending" => to_json(&store.pending(num(op, "limit"), num(op, "now"))?),
            "markUploading" => store.mark_uploading(id()).map(|()| Value::Null)?,
            "markUploaded" => store
                .mark_uploaded(id(), text(op, "key"))
                .map(|()| Value::Null)?,
            "markPending" => {
                let next = op.get("nextAttemptAt").and_then(Value::as_f64);
                store
                    .mark_pending(id(), optional_text(op, "lastError"), next)
                    .map(|()| Value::Null)?
            }
            "markRetryScheduled" => store
                .mark_retry_scheduled(id(), text(op, "lastError"), num(op, "nextAttemptAt"))
                .map(|()| Value::Null)?,
            "markTerminalFailed" => store
                .mark_terminal_failed(id(), text(op, "lastError"), num(op, "failedAt"))
                .map(|()| Value::Null)?,
            "resetFailedUploads" => Value::from(store.reset_failed_uploads()?),
            "uploadSummary" => to_json(&store.upload_summary()?),
            "allForRetention" => to_json(&store.all_for_retention()?),
            "deleteByIds" => store
                .delete_by_ids(&strings(&op["ids"]))
                .map(|()| Value::Null)?,
            other => panic!("unexpected op {other}"),
        })
    }
}

struct Lark(LarkTaskCache);

impl Replay for Lark {
    fn open(conn: Connection, _step: Option<&Value>, _case: &Value) -> rusqlite::Result<Self> {
        LarkTaskCache::new(conn).map(Self)
    }

    fn apply(&mut self, op: &Value) -> rusqlite::Result<Value> {
        let store = &mut self.0;
        let owner = from::<LarkTaskCacheOwner>(&op["owner"]);
        Ok(match text(op, "op") {
            "replace" => {
                let tasks = from::<Vec<CachedLarkTask>>(&op["tasks"]);
                match store.replace(&owner, &tasks, num(op, "fetchedAt")) {
                    Ok(()) => Value::Null,
                    Err(LarkCacheError::Sql(error)) => return Err(error),
                    Err(other) => panic!("{other}"),
                }
            }
            "list" => to_json(&store.list(&owner)?),
            "has" => Value::from(store.has(&owner)?),
            other => panic!("unexpected op {other}"),
        })
    }
}

#[test]
fn activity_store_matches_the_typescript() {
    assert_cases("activity_store", replay::<Activity>);
}

#[test]
fn capture_store_matches_the_typescript() {
    assert_cases("capture_store", replay::<Capture>);
}

#[test]
fn lark_task_cache_matches_the_typescript() {
    assert_cases("lark_task_cache", replay::<Lark>);
}
