//! Taking ownership of legacy rows. SQL copied from `sqliteStore.ts`.

use rusqlite::{Connection, named_params, params};
use timo_core::timer::TimerError;
use timo_core::timer::types::{EntryMatch, TimerOwner};

use super::db::{db_err, lock};
use super::entry_store::SqliteEntryStore;
use super::parse::parse_entry;
use super::writes::json_of;

/// `SELECT id, ended_at, json FROM local_entries WHERE owner ... IS NULL`.
fn unowned_rows(tx: &Connection) -> Result<Vec<(String, Option<f64>, String)>, TimerError> {
    let mut stmt = tx
        .prepare(
            "SELECT id, ended_at, json FROM local_entries
         WHERE owner_user_id IS NULL AND owner_workspace_id IS NULL",
        )
        .map_err(db_err)?;
    stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<f64>>(1)?,
            row.get::<_, String>(2)?,
        ))
    })
    .map_err(db_err)?
    .collect::<Result<Vec<_>, _>>()
    .map_err(db_err)
}

/// Copy the four un-namespaced meta keys to the owner's namespace.
fn carry_meta_over(tx: &Connection, owner: &TimerOwner) -> Result<(), TimerError> {
    for key in ["liveness", "exit_intent", "away_state", "recovery_notice"] {
        tx.execute(
            "INSERT OR IGNORE INTO timer_meta (key, value)
             SELECT @nextKey, value FROM timer_meta WHERE key = @legacyKey",
            named_params! { "@nextKey": SqliteEntryStore::meta_key(owner, key), "@legacyKey": key },
        )
        .map_err(db_err)?;
    }
    Ok(())
}

impl SqliteEntryStore {
    /// `claimUnownedEntries`: claim only rows already naming the authenticated
    /// user. Older agents wrote the placeholder `"self"`, which stays
    /// quarantined until the server proves id + clientUuid.
    pub(super) fn claim_unowned(&self, owner: &TimerOwner) -> Result<usize, TimerError> {
        let mut db = lock(&self.db);
        let tx = db.transaction().map_err(db_err)?;
        let rows = unowned_rows(&tx)?;
        let mut claimed = 0;
        let mut claimed_open = false;
        for (id, ended_at, json) in rows {
            let entry = parse_entry(&json)?;
            if entry.user_id != owner.user_id {
                continue;
            }
            let changes = tx
                .execute(
                    "UPDATE local_entries
         SET owner_user_id = @userId, owner_workspace_id = @workspaceId, json = @json
         WHERE id = @id AND owner_user_id IS NULL AND owner_workspace_id IS NULL",
                    named_params! {
                        "@id": id,
                        "@userId": owner.user_id,
                        "@workspaceId": owner.workspace_id,
                        "@json": json_of(&entry)?,
                    },
                )
                .map_err(db_err)?;
            claimed += changes;
            if changes > 0 && ended_at.is_none() {
                claimed_open = true;
            }
        }
        if claimed_open {
            carry_meta_over(&tx, owner)?;
        }
        tx.commit().map_err(db_err)?;
        Ok(claimed)
    }

    /// `claimServerMatchedEntries`: claim only closed legacy rows whose exact
    /// `(id, client_uuid)` the owner-scoped server snapshot proves.
    pub(super) fn claim_matched(
        &self,
        owner: &TimerOwner,
        matches: &[EntryMatch],
    ) -> Result<usize, TimerError> {
        if matches.is_empty() {
            return Ok(0);
        }
        let mut db = lock(&self.db);
        let tx = db.transaction().map_err(db_err)?;
        let mut claimed = 0;
        for found in matches {
            let json = {
                let mut stmt = tx
                    .prepare(
                        "SELECT json FROM local_entries
         WHERE id = ? AND client_uuid = ?
           AND ended_at IS NOT NULL
           AND owner_user_id IS NULL AND owner_workspace_id IS NULL",
                    )
                    .map_err(db_err)?;
                let mut rows = stmt
                    .query(params![found.id, found.client_uuid])
                    .map_err(db_err)?;
                match rows.next().map_err(db_err)? {
                    Some(row) => row.get::<_, String>(0).map_err(db_err)?,
                    None => continue,
                }
            };
            let mut entry = parse_entry(&json)?;
            entry.user_id.clone_from(&owner.user_id);
            claimed += tx
                .execute(
                    "UPDATE local_entries
         SET owner_user_id = @userId, owner_workspace_id = @workspaceId, json = @json
         WHERE id = @id AND client_uuid = @clientUuid
           AND ended_at IS NOT NULL
           AND owner_user_id IS NULL AND owner_workspace_id IS NULL",
                    named_params! {
                        "@id": found.id,
                        "@clientUuid": found.client_uuid,
                        "@userId": owner.user_id,
                        "@workspaceId": owner.workspace_id,
                        "@json": json_of(&entry)?,
                    },
                )
                .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        Ok(claimed)
    }
}
