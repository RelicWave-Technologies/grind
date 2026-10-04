//! The state dumps recorded after every step: `dumpEntries`, `dumpMeta`,
//! `dumpCache` of `parity/src/scenarios/timerWorld.ts`.

use rusqlite::Connection;
use serde::Serialize;

#[derive(Serialize)]
pub struct RowDump {
    pub rowid: f64,
    pub id: String,
    pub client_uuid: String,
    pub ended_at: Option<f64>,
    pub ended_at_type: String,
    pub synced: f64,
    pub sync_state: String,
    pub owner_user_id: Option<String>,
    pub owner_workspace_id: Option<String>,
    pub acknowledged_revision: Option<f64>,
    pub acknowledged_revision_type: String,
    pub acknowledged_hash: Option<String>,
    pub json: String,
}

#[derive(Serialize)]
pub struct MetaRow {
    pub key: String,
    pub value: String,
}

#[derive(Serialize)]
pub struct CacheRow {
    pub owner_user_id: String,
    pub owner_workspace_id: String,
    pub day_start: f64,
    pub day_start_type: String,
    pub day_end: f64,
    pub entry_id: String,
    pub client_uuid: String,
    pub revision: f64,
    pub revision_type: String,
    pub fetched_at: f64,
    pub fetched_at_type: String,
    pub canonical_json: String,
    pub effective_json: Option<String>,
}

/// A column read as better-sqlite3 reads it: a number, text or null, whatever the
/// column's declared type (SQLite does not enforce it, and a scenario may store text).
#[derive(Serialize)]
#[serde(untagged)]
pub enum Cell {
    Number(f64),
    Text(String),
    Null,
}

impl rusqlite::types::FromSql for Cell {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
        use rusqlite::types::ValueRef;
        Ok(match value {
            ValueRef::Integer(_) | ValueRef::Real(_) => Self::Number(f64::column_result(value)?),
            ValueRef::Text(_) => Self::Text(String::column_result(value)?),
            ValueRef::Null | ValueRef::Blob(_) => Self::Null,
        })
    }
}

#[derive(Serialize)]
pub struct CacheMeta {
    pub owner_user_id: String,
    pub owner_workspace_id: String,
    pub day_start: f64,
    pub day_end: Cell,
    pub server_time: f64,
    pub server_time_type: String,
    pub workspace_timezone: String,
    pub fetched_at: f64,
    pub fetched_at_type: String,
}

#[derive(Serialize)]
pub struct CacheDump {
    pub entries: Vec<CacheRow>,
    pub meta: Vec<CacheMeta>,
}

pub fn dump_entries(db: &Connection) -> Vec<RowDump> {
    let mut stmt = db
        .prepare(
            "SELECT rowid, id, client_uuid, ended_at, typeof(ended_at) AS ended_at_type, synced, sync_state,
              owner_user_id, owner_workspace_id, acknowledged_revision,
              typeof(acknowledged_revision) AS acknowledged_revision_type, acknowledged_hash, json
       FROM local_entries ORDER BY rowid",
        )
        .unwrap();
    stmt.query_map([], |r| {
        Ok(RowDump {
            rowid: r.get(0)?,
            id: r.get(1)?,
            client_uuid: r.get(2)?,
            ended_at: r.get(3)?,
            ended_at_type: r.get(4)?,
            synced: r.get(5)?,
            sync_state: r.get(6)?,
            owner_user_id: r.get(7)?,
            owner_workspace_id: r.get(8)?,
            acknowledged_revision: r.get(9)?,
            acknowledged_revision_type: r.get(10)?,
            acknowledged_hash: r.get(11)?,
            json: r.get(12)?,
        })
    })
    .unwrap()
    .map(Result::unwrap)
    .collect()
}

pub fn dump_meta(db: &Connection) -> Vec<MetaRow> {
    let mut stmt = db
        .prepare("SELECT key, value FROM timer_meta ORDER BY key")
        .unwrap();
    stmt.query_map([], |r| {
        Ok(MetaRow {
            key: r.get(0)?,
            value: r.get(1)?,
        })
    })
    .unwrap()
    .map(Result::unwrap)
    .collect()
}

fn cache_rows(db: &Connection) -> rusqlite::Result<Vec<CacheRow>> {
    let mut stmt = db
        .prepare(
            "SELECT owner_user_id, owner_workspace_id, day_start, typeof(day_start) AS day_start_type, day_end, entry_id,
                client_uuid, revision, typeof(revision) AS revision_type, fetched_at, typeof(fetched_at) AS fetched_at_type,
                canonical_json, effective_json
         FROM server_entry_cache ORDER BY owner_user_id, owner_workspace_id, day_start, entry_id",
        )
        ?;
    stmt.query_map([], |r| {
        Ok(CacheRow {
            owner_user_id: r.get(0)?,
            owner_workspace_id: r.get(1)?,
            day_start: r.get(2)?,
            day_start_type: r.get(3)?,
            day_end: r.get(4)?,
            entry_id: r.get(5)?,
            client_uuid: r.get(6)?,
            revision: r.get(7)?,
            revision_type: r.get(8)?,
            fetched_at: r.get(9)?,
            fetched_at_type: r.get(10)?,
            canonical_json: r.get(11)?,
            effective_json: r.get(12)?,
        })
    })?
    .collect()
}

fn cache_meta(db: &Connection) -> rusqlite::Result<Vec<CacheMeta>> {
    let mut stmt = db
        .prepare(
            "SELECT owner_user_id, owner_workspace_id, day_start, day_end, server_time, typeof(server_time) AS server_time_type,
                workspace_timezone, fetched_at, typeof(fetched_at) AS fetched_at_type
         FROM server_snapshot_meta ORDER BY owner_user_id, owner_workspace_id, day_start",
        )
        ?;
    stmt.query_map([], |r| {
        Ok(CacheMeta {
            owner_user_id: r.get(0)?,
            owner_workspace_id: r.get(1)?,
            day_start: r.get(2)?,
            day_end: r.get(3)?,
            server_time: r.get(4)?,
            server_time_type: r.get(5)?,
            workspace_timezone: r.get(6)?,
            fetched_at: r.get(7)?,
            fetched_at_type: r.get(8)?,
        })
    })?
    .collect()
}

/// The cache tables, or the error a broken table raises: `dumpCache` of the TypeScript
/// harness, which a scenario may sabotage.
#[derive(Serialize)]
#[serde(untagged)]
pub enum CacheState {
    Tables(CacheDump),
    Broken { error: String },
}

pub fn dump_cache(db: &Connection) -> CacheState {
    match (cache_rows(db), cache_meta(db)) {
        (Ok(entries), Ok(meta)) => CacheState::Tables(CacheDump { entries, meta }),
        (Err(error), _) | (_, Err(error)) => CacheState::Broken {
            error: error.to_string(),
        },
    }
}
