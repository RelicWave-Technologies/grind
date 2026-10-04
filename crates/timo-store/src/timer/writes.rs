//! The write queries of the entry journal. SQL copied from `sqliteStore.ts`.

use rusqlite::{Connection, OptionalExtension, named_params, params};
use timo_core::js::ser::to_string;
use timo_core::timer::TimerError;
use timo_core::timer::types::{Acknowledgement, EntrySyncState, PendingEntrySyncState, TimerOwner};
use timo_core::types::TimeEntry;

use super::db::{db_err, lock};
use super::entry_store::SqliteEntryStore;
use super::parse::as_sync_state;

/// `JSON.stringify(entry)`.
pub(super) fn json_of(entry: &TimeEntry) -> Result<String, TimerError> {
    to_string(entry).map_err(|e| TimerError::Store(e.to_string()))
}

/// The state `upsert` assigns when the caller names none: a not-yet-created
/// entry stays `pending_create`, a server-created one becomes `pending_update`.
fn default_state(existing: Option<EntrySyncState>) -> PendingEntrySyncState {
    match existing {
        Some(EntrySyncState::PendingCreate) | None => PendingEntrySyncState::PendingCreate,
        Some(_) => PendingEntrySyncState::PendingUpdate,
    }
}

/// The two ownership checks at the top of `upsert`.
fn ensure_owned(db: &Connection, owner: &TimerOwner, entry: &TimeEntry) -> Result<(), TimerError> {
    if entry.user_id != owner.user_id {
        return Err(TimerError::OwnerMismatch);
    }
    let existing_owner = db
        .query_row(
            "SELECT owner_user_id, owner_workspace_id FROM local_entries WHERE id = ?",
            params![entry.id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()
        .map_err(db_err)?;
    if let Some((user, workspace)) = existing_owner
        && (user.as_deref() != Some(owner.user_id.as_str())
            || workspace.as_deref() != Some(owner.workspace_id.as_str()))
    {
        return Err(TimerError::EntryOwnedByAnotherSession);
    }
    Ok(())
}

/// `upsert` against a connection or an open transaction.
pub(super) fn upsert_in(
    db: &Connection,
    owner: &TimerOwner,
    entry: &TimeEntry,
    forced: Option<PendingEntrySyncState>,
) -> Result<PendingEntrySyncState, TimerError> {
    ensure_owned(db, owner, entry)?;
    let existing = db
        .query_row(
            "SELECT sync_state FROM local_entries
       WHERE id = ? AND owner_user_id = ? AND owner_workspace_id = ?",
            params![entry.id, owner.user_id, owner.workspace_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(db_err)?;
    let next_state =
        forced.unwrap_or_else(|| default_state(existing.as_deref().map(as_sync_state)));
    db.execute(
        "INSERT INTO local_entries (
           id, client_uuid, ended_at, synced, sync_state,
           owner_user_id, owner_workspace_id, acknowledged_revision, acknowledged_hash, json
         )
         VALUES (
           @id, @clientUuid, @endedAt, @synced, @syncState,
           @ownerUserId, @ownerWorkspaceId, NULL, NULL, @json
         )
         ON CONFLICT(id) DO UPDATE SET
           ended_at = excluded.ended_at,
           synced   = excluded.synced,
           sync_state = excluded.sync_state,
           acknowledged_revision = CASE WHEN excluded.json = local_entries.json
             THEN local_entries.acknowledged_revision ELSE NULL END,
           acknowledged_hash = CASE WHEN excluded.json = local_entries.json
             THEN local_entries.acknowledged_hash ELSE NULL END,
           json     = excluded.json",
        named_params! {
            "@id": entry.id,
            "@clientUuid": entry.client_uuid,
            "@endedAt": entry.ended_at,
            // `syncedFlag(nextState)`: a pending state is never synced.
            "@synced": 0_i64,
            "@syncState": next_state.as_str(),
            "@ownerUserId": owner.user_id,
            "@ownerWorkspaceId": owner.workspace_id,
            "@json": json_of(entry)?,
        },
    )
    .map_err(db_err)?;
    Ok(next_state)
}

impl SqliteEntryStore {
    /// `upsert`.
    pub(super) fn upsert_entry(
        &self,
        entry: &TimeEntry,
        forced: Option<PendingEntrySyncState>,
    ) -> Result<PendingEntrySyncState, TimerError> {
        let owner = self.require_owner()?;
        upsert_in(&lock(&self.db), owner, entry, forced)
    }

    /// `switchEntry`: close the old task and create the replacement in one
    /// transaction; either both land or neither does.
    pub(super) fn switch(
        &self,
        closed: &TimeEntry,
        next: &TimeEntry,
    ) -> Result<(PendingEntrySyncState, PendingEntrySyncState), TimerError> {
        let owner = self.require_owner()?;
        let mut db = lock(&self.db);
        let tx = db.transaction().map_err(db_err)?;
        let closed_state = upsert_in(&tx, owner, closed, None)?;
        let next_state = upsert_in(&tx, owner, next, Some(PendingEntrySyncState::PendingCreate))?;
        tx.commit().map_err(db_err)?;
        Ok((closed_state, next_state))
    }

    /// `markCreated`: stale responses cannot dirty newer JSON.
    pub(super) fn mark_created_impl(
        &self,
        entry_id: &str,
        expected: &TimeEntry,
    ) -> Result<bool, TimerError> {
        let owner = self.require_owner()?;
        let changes = lock(&self.db)
            .execute(
                "UPDATE local_entries SET synced = 0, sync_state = 'pending_update'
       WHERE id = ? AND owner_user_id = ? AND owner_workspace_id = ?
         AND json = ? AND sync_state = 'pending_create'",
                params![
                    entry_id,
                    owner.user_id,
                    owner.workspace_id,
                    json_of(expected)?
                ],
            )
            .map_err(db_err)?;
        Ok(changes > 0)
    }

    /// `markPendingCreate`.
    pub(super) fn mark_pending_create_impl(
        &self,
        entry_id: &str,
        expected: &TimeEntry,
    ) -> Result<bool, TimerError> {
        let owner = self.require_owner()?;
        let changes = lock(&self.db)
            .execute(
                "UPDATE local_entries SET synced = 0, sync_state = 'pending_create'
       WHERE id = ? AND owner_user_id = ? AND owner_workspace_id = ?
         AND json = ?",
                params![
                    entry_id,
                    owner.user_id,
                    owner.workspace_id,
                    json_of(expected)?
                ],
            )
            .map_err(db_err)?;
        Ok(changes > 0)
    }

    /// `markSynced`: clean only if the stored JSON still equals the snapshot.
    pub(super) fn mark_synced_impl(
        &self,
        entry_id: &str,
        expected: &TimeEntry,
        acknowledgement: &Acknowledgement,
    ) -> Result<bool, TimerError> {
        let owner = self.require_owner()?;
        let changes = lock(&self.db)
            .execute(
                "UPDATE local_entries
       SET synced = 1, sync_state = 'synced',
           acknowledged_revision = @revision, acknowledged_hash = @hash
       WHERE id = @id AND owner_user_id = @ownerUserId AND owner_workspace_id = @ownerWorkspaceId
         AND json = @json",
                named_params! {
                    "@id": entry_id,
                    "@ownerUserId": owner.user_id,
                    "@ownerWorkspaceId": owner.workspace_id,
                    "@json": json_of(expected)?,
                    "@revision": acknowledgement.revision,
                    "@hash": acknowledgement.hash,
                },
            )
            .map_err(db_err)?;
        Ok(changes > 0)
    }
}
