//! The read queries of the entry journal. SQL copied from `sqliteStore.ts`.

use rusqlite::{OptionalExtension, params};
use timo_core::js::number::f64_to_i64;
use timo_core::timer::TimerError;
use timo_core::timer::types::{EntrySyncState, PendingEntrySyncState, UnsyncedEntry};
use timo_core::today_ledger::LocalLedgerEntry;
use timo_core::types::TimeEntry;

use super::db::{db_err, lock};
use super::entry_store::SqliteEntryStore;
use super::parse::{as_sync_state, parse_entry};

/// `rows.map((r) => parseEntry(r.json))`.
fn entries(rows: &[String]) -> Result<Vec<TimeEntry>, TimerError> {
    rows.iter().map(|json| parse_entry(json)).collect()
}

impl SqliteEntryStore {
    /// `getOpen`: the newest inserted open row of this owner.
    pub(super) fn open_entry(&self) -> Result<Option<TimeEntry>, TimerError> {
        let Some(owner) = &self.owner else {
            return Ok(None);
        };
        let row = lock(&self.db)
            .query_row(
                "SELECT json FROM local_entries
       WHERE owner_user_id = ? AND owner_workspace_id = ? AND ended_at IS NULL
       ORDER BY rowid DESC LIMIT 1",
                params![owner.user_id, owner.workspace_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_err)?;
        row.as_deref().map(parse_entry).transpose()
    }

    /// `getUnsynced`: oldest first.
    pub(super) fn unsynced_entries(&self) -> Result<Vec<UnsyncedEntry>, TimerError> {
        let Some(owner) = &self.owner else {
            return Ok(Vec::new());
        };
        let db = lock(&self.db);
        let mut stmt = db
            .prepare(
                "SELECT json, sync_state
         FROM local_entries
         WHERE owner_user_id = ? AND owner_workspace_id = ?
           AND sync_state IN ('pending_create', 'pending_update')
         ORDER BY rowid ASC",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![owner.user_id, owner.workspace_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        rows.into_iter()
            .map(|(json, state)| {
                // `asSyncState(...) as PendingEntrySyncState`: a `synced` row
                // cannot match the WHERE, so the cast never lies.
                let sync_state = match as_sync_state(&state) {
                    EntrySyncState::PendingUpdate => PendingEntrySyncState::PendingUpdate,
                    _ => PendingEntrySyncState::PendingCreate,
                };
                Ok(UnsyncedEntry {
                    entry: parse_entry(&json)?,
                    sync_state,
                })
            })
            .collect()
    }

    /// `hasUnsynced`.
    pub(super) fn any_unsynced(&self) -> Result<bool, TimerError> {
        let Some(owner) = &self.owner else {
            return Ok(false);
        };
        let row = lock(&self.db)
            .query_row(
                "SELECT 1 AS found FROM local_entries
       WHERE owner_user_id = ? AND owner_workspace_id = ?
         AND sync_state IN ('pending_create', 'pending_update') LIMIT 1",
                params![owner.user_id, owner.workspace_id],
                |row| row.get::<_, i64>(0),
            )
            .optional()
            .map_err(db_err)?;
        Ok(row.is_some())
    }

    /// `getSyncState` (private in the TypeScript).
    pub(super) fn sync_state_of(
        &self,
        entry_id: &str,
    ) -> Result<Option<EntrySyncState>, TimerError> {
        let Some(owner) = &self.owner else {
            return Ok(None);
        };
        let state = lock(&self.db)
            .query_row(
                "SELECT sync_state FROM local_entries
       WHERE id = ? AND owner_user_id = ? AND owner_workspace_id = ?",
                params![entry_id, owner.user_id, owner.workspace_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(db_err)?;
        Ok(state.as_deref().map(as_sync_state))
    }

    /// `listRecent` [unused in production].
    pub(super) fn recent(&self, limit: f64) -> Result<Vec<TimeEntry>, TimerError> {
        let Some(owner) = &self.owner else {
            return Ok(Vec::new());
        };
        // better-sqlite3 binds an integral number as an integer; SQLite rejects
        // a fractional LIMIT with "datatype mismatch".
        let limit =
            f64_to_i64(limit).map_err(|_| TimerError::Store("datatype mismatch".to_owned()))?;
        let db = lock(&self.db);
        let mut stmt = db
            .prepare(
                "SELECT json FROM local_entries
       WHERE owner_user_id = ? AND owner_workspace_id = ?
       ORDER BY rowid DESC LIMIT ?",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![owner.user_id, owner.workspace_id, limit], |row| {
                row.get::<_, String>(0)
            })
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        entries(&rows)
    }

    /// `listSince` [unused in production].
    pub(super) fn since(&self, since: f64) -> Result<Vec<TimeEntry>, TimerError> {
        let Some(owner) = &self.owner else {
            return Ok(Vec::new());
        };
        let db = lock(&self.db);
        let mut stmt = db
            .prepare(
                "SELECT json FROM local_entries
         WHERE owner_user_id = ? AND owner_workspace_id = ?
           AND (ended_at IS NULL OR ended_at >= ?)
         ORDER BY rowid DESC",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![owner.user_id, owner.workspace_id, since], |row| {
                row.get::<_, String>(0)
            })
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        entries(&rows)
    }

    /// `listLedgerEntries`: open rows and rows ending at/after the day start.
    pub(super) fn ledger_entries(&self, since: f64) -> Result<Vec<LocalLedgerEntry>, TimerError> {
        let Some(owner) = &self.owner else {
            return Ok(Vec::new());
        };
        let db = lock(&self.db);
        let mut stmt = db
            .prepare(
                "SELECT json, sync_state, acknowledged_revision, acknowledged_hash
       FROM local_entries
       WHERE owner_user_id = ? AND owner_workspace_id = ?
         AND (ended_at IS NULL OR ended_at >= ?)
       ORDER BY rowid DESC",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![owner.user_id, owner.workspace_id, since], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<f64>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(db_err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_err)?;
        rows.into_iter()
            .map(|(json, state, revision, hash)| {
                Ok(LocalLedgerEntry {
                    entry: parse_entry(&json)?,
                    sync_state: as_sync_state(&state),
                    acknowledged_revision: revision,
                    acknowledged_hash: hash,
                })
            })
            .collect()
    }
}
