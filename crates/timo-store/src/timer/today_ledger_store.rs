//! The server snapshot cache.
//!
//! Port of `legacy/agent/src/main/services/timer/todayLedgerStore.ts::SqliteTodayLedgerStore`.
//! Advisory: a corrupt cache reads as empty and the next refresh rewrites it.

use std::sync::Arc;

use rusqlite::types::Value as SqlValue;
use rusqlite::{Connection, OptionalExtension, params};
use timo_core::js::number::{i64_to_f64, strict_eq};
use timo_core::timer::TimerError;
use timo_core::timer::dto::{EffectiveEntry, TimeEntryDto, TodayLedgerResponse, iso_ms};
use timo_core::timer::hash::sha256_hex;
use timo_core::timer::hydrator::HydratorCache;
use timo_core::timer::traits::ServerLedgerCache;
use timo_core::timer::types::{DayWindow, TimerOwner};
use timo_core::today_ledger::ServerLedgerEntry;

use super::db::{SharedDb, db_err, lock};
use super::effective::{fallback_effective_entry, parse_effective_entry, to_effective_core_entry};
use super::ledger_snapshot::{SnapshotAt, canonical_payload, insert_row, validated_rows};

/// `Date.now()`: the device clock, only for the informational `fetched_at`.
pub type DeviceNow = Arc<dyn Fn() -> f64 + Send + Sync>;

/// Port of `SqliteTodayLedgerStore`.
pub struct SqliteTodayLedgerStore {
    db: SharedDb,
    device_now: DeviceNow,
}

impl std::fmt::Debug for SqliteTodayLedgerStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SqliteTodayLedgerStore")
            .finish_non_exhaustive()
    }
}

fn prepare_tables(db: &Connection) -> Result<(), TimerError> {
    db.execute_batch(
        "
      CREATE TABLE IF NOT EXISTS server_entry_cache (
        owner_user_id TEXT NOT NULL,
        owner_workspace_id TEXT NOT NULL,
        day_start INTEGER NOT NULL,
        day_end INTEGER NOT NULL,
        entry_id TEXT NOT NULL,
        client_uuid TEXT NOT NULL,
        revision INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        canonical_json TEXT NOT NULL,
        effective_json TEXT,
        PRIMARY KEY (owner_user_id, owner_workspace_id, day_start, entry_id)
      );
      CREATE INDEX IF NOT EXISTS idx_server_entry_cache_owner_day
        ON server_entry_cache(owner_user_id, owner_workspace_id, day_start, day_end);
      CREATE TABLE IF NOT EXISTS server_snapshot_meta (
        owner_user_id TEXT NOT NULL,
        owner_workspace_id TEXT NOT NULL,
        day_start INTEGER NOT NULL,
        day_end INTEGER NOT NULL,
        server_time INTEGER NOT NULL,
        workspace_timezone TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        PRIMARY KEY (owner_user_id, owner_workspace_id, day_start)
      );
    ",
    )
    .map_err(db_err)?;
    let mut stmt = db
        .prepare("PRAGMA table_info(server_entry_cache)")
        .map_err(db_err)?;
    let has_effective = stmt
        .query_map([], |row| row.get::<_, String>("name"))
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?
        .iter()
        .any(|name| name == "effective_json");
    drop(stmt);
    if !has_effective {
        db.execute_batch("ALTER TABLE server_entry_cache ADD COLUMN effective_json TEXT")
            .map_err(db_err)?;
    }
    Ok(())
}

/// A cached `(canonical_json, effective_json)` row.
/// `canonical_json, effective_json` as SQLite holds them: a column is not guaranteed to be
/// the text its declaration says, and the TypeScript reads whatever is there.
type CachedRow = (SqlValue, SqlValue);

impl SqliteTodayLedgerStore {
    /// Port of the constructor. `device_now` is `Date.now()` (D-frame), used only
    /// for the informational `fetched_at`.
    pub fn new(db: SharedDb, device_now: DeviceNow) -> Result<Self, TimerError> {
        prepare_tables(&lock(&db))?;
        Ok(Self { db, device_now })
    }

    /// Port of `replaceSnapshot` with `fetchedAt` defaulted to the device clock.
    pub fn replace_snapshot(
        &self,
        owner: &TimerOwner,
        window: DayWindow,
        response: &TodayLedgerResponse,
    ) -> Result<(), TimerError> {
        let fetched_at = (self.device_now)();
        self.replace_snapshot_at(&SnapshotAt {
            owner,
            window,
            response,
            fetched_at,
        })
    }

    /// Port of `replaceSnapshot` with an explicit `fetchedAt`.
    pub fn replace_snapshot_at(&self, snapshot: &SnapshotAt<'_>) -> Result<(), TimerError> {
        let SnapshotAt {
            owner,
            window,
            response,
            fetched_at,
        } = *snapshot;
        let rows = validated_rows(owner, response)?;
        let server_time = iso_ms(&response.server_time)?;
        if !server_time.is_finite() {
            return Err(TimerError::Store(
                "invalid_today_ledger_server_time".to_owned(),
            ));
        }
        let mut db = lock(&self.db);
        let tx = db.transaction().map_err(db_err)?;
        tx.execute(
            "DELETE FROM server_entry_cache
         WHERE owner_user_id = ? AND owner_workspace_id = ? AND day_start = ?",
            params![owner.user_id, owner.workspace_id, window.start],
        )
        .map_err(db_err)?;
        for row in &rows {
            insert_row(&tx, snapshot, row)?;
        }
        tx.execute(
            "INSERT INTO server_snapshot_meta (
           owner_user_id, owner_workspace_id, day_start, day_end,
           server_time, workspace_timezone, fetched_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(owner_user_id, owner_workspace_id, day_start) DO UPDATE SET
           day_end = excluded.day_end,
           server_time = excluded.server_time,
           workspace_timezone = excluded.workspace_timezone,
           fetched_at = excluded.fetched_at",
            params![
                owner.user_id,
                owner.workspace_id,
                window.start,
                window.end,
                server_time,
                response.workspace_timezone,
                fetched_at
            ],
        )
        .map_err(db_err)?;
        tx.commit().map_err(db_err)
    }

    /// The rows of one cached snapshot, or `None` when there is none for this
    /// exact window.
    fn cached_rows(
        &self,
        owner: &TimerOwner,
        window: DayWindow,
    ) -> Result<Option<Vec<CachedRow>>, TimerError> {
        let db = lock(&self.db);
        let meta = db
            .query_row(
                "SELECT day_end FROM server_snapshot_meta
       WHERE owner_user_id = ? AND owner_workspace_id = ? AND day_start = ?",
                params![owner.user_id, owner.workspace_id, window.start],
                |row| row.get::<_, SqlValue>(0),
            )
            .optional()
            .map_err(db_err)?;
        // `meta.day_end !== windowEnd`: a column holding text or null is not the window's end.
        let same_window = match meta {
            Some(SqlValue::Integer(day_end)) => {
                i64_to_f64(day_end).is_ok_and(|n| strict_eq(n, window.end))
            }
            Some(SqlValue::Real(day_end)) => strict_eq(day_end, window.end),
            _ => false,
        };
        if !same_window {
            return Ok(None);
        }
        let mut stmt = db
            .prepare(
                "SELECT canonical_json, effective_json FROM server_entry_cache
       WHERE owner_user_id = ? AND owner_workspace_id = ? AND day_start = ? AND day_end = ?
       ORDER BY entry_id ASC",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(
                params![owner.user_id, owner.workspace_id, window.start, window.end],
                |row| Ok((row.get::<_, SqlValue>(0)?, row.get::<_, SqlValue>(1)?)),
            )
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        Ok(Some(rows))
    }

    fn list_rows(rows: &[CachedRow], now: f64) -> Result<Vec<ServerLedgerEntry>, TimerError> {
        let mut out = Vec::with_capacity(rows.len());
        for (canonical_json, effective_json) in rows {
            // Anything but text is not JSON the DTO parse accepts (`JSON.parse(5)` is 5).
            let SqlValue::Text(canonical_json) = canonical_json else {
                return Err(TimerError::Store("canonical_json is not text".to_owned()));
            };
            let canonical: TimeEntryDto = serde_json::from_str(canonical_json)
                .map_err(|e| TimerError::Store(e.to_string()))?;
            canonical
                .validate()
                .map_err(|e| TimerError::Store(e.to_string()))?;
            // `if (row.effective_json)`: null, '' and 0 take the fallback.
            let falsy = match effective_json {
                SqlValue::Null | SqlValue::Integer(0) => true,
                SqlValue::Text(json) => json.is_empty(),
                SqlValue::Real(n) => strict_eq(*n, 0.0),
                _ => false,
            };
            let effective: EffectiveEntry = match effective_json {
                _ if falsy => fallback_effective_entry(&canonical),
                SqlValue::Text(json) => parse_effective_entry(json, &canonical)?,
                _ => return Err(TimerError::Store("effective_json is not JSON".to_owned())),
            };
            let canonical_payload = canonical_payload(&canonical)?;
            out.push(ServerLedgerEntry {
                entry: to_effective_core_entry(&canonical, &effective, now)?,
                canonical_hash: sha256_hex(&canonical_payload),
                canonical_payload,
            });
        }
        Ok(out)
    }
}

impl ServerLedgerCache for SqliteTodayLedgerStore {
    /// Port of `list`. A failed meta/rows query throws in the TypeScript, outside its `try`,
    /// and is an `Err` here. Rows that cannot be parsed read as an empty cache: never
    /// expose a partial snapshot, never let corrupt cache JSON block the local journal.
    fn list(
        &self,
        owner: &TimerOwner,
        window: DayWindow,
        now: f64,
    ) -> Result<Vec<ServerLedgerEntry>, TimerError> {
        let rows = self.cached_rows(owner, window)?.unwrap_or_default();
        Ok(Self::list_rows(&rows, now).unwrap_or_default())
    }
}

impl HydratorCache for SqliteTodayLedgerStore {
    fn replace_snapshot(
        &self,
        owner: &TimerOwner,
        window: DayWindow,
        response: &TodayLedgerResponse,
    ) -> Result<(), String> {
        Self::replace_snapshot(self, owner, window, response).map_err(|e| e.to_string())
    }
}
