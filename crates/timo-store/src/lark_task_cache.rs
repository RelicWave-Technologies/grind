//! Durable, owner-scoped mirror of the most recently fetched Lark task list.
//!
//! It exists solely so known tasks remain selectable while the network is down;
//! task creation and task changes still require the server and Lark.
//!
//! Port of `legacy/agent/src/main/services/larkTaskCache.ts`. Each task is stored
//! as the text `JSON.stringify(task)` writes (through `timo_core::js::ser`), so the
//! `json` column is byte for byte what the Electron agent stores for the same task.

use rusqlite::{Connection, OptionalExtension, Result, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;
use timo_core::js::ser::{SerError, to_string};

use crate::row_value::js_string;

/// Port of `CachedLarkTask`. Field order is the order the API writes them, which
/// is the order `JSON.stringify` wrote them in the Electron agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedLarkTask {
    pub guid: String,
    pub summary: String,
    pub completed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub due: Option<f64>,
    pub created_at: Option<f64>,
    pub creator_id: Option<String>,
    pub creator_name: Option<String>,
    pub logged_ms: f64,
    pub logged_today_ms: f64,
    pub logged_total_ms: f64,
    /// Keys this version does not know (and a `url` that is not a string), carried
    /// through untouched, as the TypeScript passes the parsed object through.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Port of `LarkTaskCacheOwner`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LarkTaskCacheOwner {
    pub user_id: String,
    pub workspace_id: String,
}

/// What can go wrong writing the cache.
#[derive(Debug, Error)]
pub enum LarkCacheError {
    /// SQLite refused.
    #[error("lark task cache: {0}")]
    Sql(#[from] rusqlite::Error),
    /// A task could not be written as JSON.
    #[error("lark task cache: {0}")]
    Json(#[from] SerError),
}

/// Port of `LarkTaskCache`. Owns its connection, like the TypeScript's own `Database`.
#[derive(Debug)]
pub struct LarkTaskCache {
    conn: Connection,
}

impl LarkTaskCache {
    /// Port of `LarkTaskCache.constructor`.
    pub fn new(conn: Connection) -> Result<Self> {
        conn.execute_batch(
            "
      CREATE TABLE IF NOT EXISTS lark_task_cache (
        owner_user_id TEXT NOT NULL,
        owner_workspace_id TEXT NOT NULL,
        guid TEXT NOT NULL,
        json TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (owner_user_id, owner_workspace_id, guid)
      );
      CREATE INDEX IF NOT EXISTS idx_lark_task_cache_owner
        ON lark_task_cache(owner_user_id, owner_workspace_id, fetched_at DESC);
    ",
        )?;
        Ok(Self { conn })
    }

    /// The connection, for diagnostics and tests.
    #[must_use]
    pub fn connection(&self) -> &Connection {
        &self.conn
    }

    /// Hands the connection back (a second cache over the same database, as a reboot is).
    #[must_use]
    pub fn into_connection(self) -> Connection {
        self.conn
    }

    /// Replace the owner's snapshot atomically. `fetched_at` is the TypeScript's
    /// `Date.now()` default, injected. Port of
    /// `legacy/agent/src/main/services/larkTaskCache.ts::LarkTaskCache.replace`.
    pub fn replace(
        &mut self,
        owner: &LarkTaskCacheOwner,
        tasks: &[CachedLarkTask],
        fetched_at: f64,
    ) -> std::result::Result<(), LarkCacheError> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "DELETE FROM lark_task_cache WHERE owner_user_id = ? AND owner_workspace_id = ?",
            [&owner.user_id, &owner.workspace_id],
        )?;
        {
            let mut insert = tx.prepare(
                "INSERT INTO lark_task_cache (owner_user_id, owner_workspace_id, guid, json, fetched_at)
         VALUES (?, ?, ?, ?, ?)",
            )?;
            for task in tasks {
                let json = to_string(task)?;
                insert.execute(params![
                    owner.user_id,
                    owner.workspace_id,
                    task.guid,
                    json,
                    fetched_at
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Port of `LarkTaskCache.list`. A damaged cache row (unparseable, or not a
    /// task) is skipped: it must never block local tracking.
    pub fn list(&self, owner: &LarkTaskCacheOwner) -> Result<Vec<CachedLarkTask>> {
        let mut stmt = self.conn.prepare(
            "SELECT json FROM lark_task_cache
       WHERE owner_user_id = ? AND owner_workspace_id = ?
       ORDER BY fetched_at DESC, guid ASC",
        )?;
        let rows = stmt.query_map([&owner.user_id, &owner.workspace_id], |r| {
            Ok(js_string(r.get_ref("json")?))
        })?;
        let mut tasks = Vec::new();
        for row in rows {
            if let Some(task) = parse_cached_task(&row?) {
                tasks.push(task);
            }
        }
        Ok(tasks)
    }

    /// Port of `LarkTaskCache.has`.
    pub fn has(&self, owner: &LarkTaskCacheOwner) -> Result<bool> {
        let found: Option<i64> = self
            .conn
            .query_row(
                "SELECT 1 FROM lark_task_cache WHERE owner_user_id = ? AND owner_workspace_id = ? LIMIT 1",
                [&owner.user_id, &owner.workspace_id],
                |r| r.get(0),
            )
            .optional()?;
        Ok(found.is_some())
    }
}

/// `JSON.parse` then `isCachedTask`; `None` for either failure.
fn parse_cached_task(json: &str) -> Option<CachedLarkTask> {
    let value: Value = serde_json::from_str(json).ok()?;
    is_cached_task(&value).then(|| to_task(&value))
}

/// Port of `legacy/agent/src/main/services/larkTaskCache.ts::isCachedTask`.
#[must_use]
pub fn is_cached_task(value: &Value) -> bool {
    let Value::Object(task) = value else {
        return false;
    };
    let string = |k: &str| matches!(task.get(k), Some(Value::String(_)));
    let number = |k: &str| matches!(task.get(k), Some(Value::Number(_)));
    let string_or_null = |k: &str| matches!(task.get(k), Some(Value::String(_) | Value::Null));
    let number_or_null = |k: &str| matches!(task.get(k), Some(Value::Number(_) | Value::Null));
    matches!(task.get("guid"), Some(Value::String(g)) if !g.is_empty())
        && string("summary")
        && matches!(task.get("completed"), Some(Value::Bool(_)))
        && number_or_null("due")
        && number_or_null("createdAt")
        && string_or_null("creatorId")
        && string_or_null("creatorName")
        && number("loggedMs")
        && number("loggedTodayMs")
        && number("loggedTotalMs")
}

/// The keys [`CachedLarkTask`] has a field for.
const KNOWN_KEYS: [&str; 11] = [
    "guid",
    "summary",
    "completed",
    "url",
    "due",
    "createdAt",
    "creatorId",
    "creatorName",
    "loggedMs",
    "loggedTodayMs",
    "loggedTotalMs",
];

/// Reads the fields of a value [`is_cached_task`] accepted; whatever else it
/// holds goes to `extra`.
fn to_task(value: &Value) -> CachedLarkTask {
    let text = |k: &str| value.get(k).and_then(Value::as_str).map(str::to_owned);
    let num = |k: &str| value.get(k).and_then(Value::as_f64);
    let url = text("url");
    let extra = value
        .as_object()
        .map(|o| {
            o.iter()
                .filter(|(k, _)| {
                    !KNOWN_KEYS.contains(&k.as_str()) || (*k == "url" && url.is_none())
                })
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect()
        })
        .unwrap_or_default();
    CachedLarkTask {
        guid: text("guid").unwrap_or_default(),
        summary: text("summary").unwrap_or_default(),
        completed: value
            .get("completed")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        url,
        due: num("due"),
        created_at: num("createdAt"),
        creator_id: text("creatorId"),
        creator_name: text("creatorName"),
        logged_ms: num("loggedMs").unwrap_or(0.0),
        logged_today_ms: num("loggedTodayMs").unwrap_or(0.0),
        logged_total_ms: num("loggedTotalMs").unwrap_or(0.0),
        extra,
    }
}
