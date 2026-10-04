//! The constructor's DDL, PRAGMAs and migrations.
//!
//! Port of the `SqliteEntryStore` constructor, `migrateSyncState` and
//! `migrateOwnership`. The SQL is copied verbatim. Migrations are feature
//! detected through `PRAGMA table_info`, not versioned, like the original.

use rusqlite::Connection;
use timo_core::timer::TimerError;

use super::db::db_err;

fn columns(db: &Connection) -> Result<Vec<String>, TimerError> {
    let mut stmt = db
        .prepare("PRAGMA table_info(local_entries)")
        .map_err(db_err)?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>("name"))
        .map_err(db_err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_err)?;
    Ok(names)
}

/// `this.db.pragma(...)` x3, the CREATE TABLEs and both migrations.
pub fn prepare_entry_tables(db: &Connection) -> Result<(), TimerError> {
    // `journal_mode` answers with a row, so it goes through a query.
    db.query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))
        .map_err(db_err)?;
    db.execute_batch("PRAGMA synchronous = FULL;")
        .map_err(db_err)?;
    db.query_row("PRAGMA busy_timeout = 5000", [], |_| Ok(()))
        .map_err(db_err)?;
    db.execute_batch(
        "
      CREATE TABLE IF NOT EXISTS local_entries (
        id          TEXT PRIMARY KEY,
        client_uuid TEXT NOT NULL UNIQUE,
        ended_at    INTEGER,
        synced      INTEGER NOT NULL DEFAULT 0,
        sync_state  TEXT NOT NULL DEFAULT 'pending_create'
          CHECK (sync_state IN ('pending_create', 'pending_update', 'synced')),
        owner_user_id TEXT,
        owner_workspace_id TEXT,
        acknowledged_revision INTEGER,
        acknowledged_hash TEXT,
        json        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_local_entries_open ON local_entries(ended_at);
      CREATE INDEX IF NOT EXISTS idx_local_entries_synced ON local_entries(synced);
      CREATE TABLE IF NOT EXISTS timer_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    ",
    )
    .map_err(db_err)?;
    migrate_sync_state(db)?;
    migrate_ownership(db)
}

fn migrate_sync_state(db: &Connection) -> Result<(), TimerError> {
    if !columns(db)?.iter().any(|name| name == "sync_state") {
        db.execute_batch(
            "
        ALTER TABLE local_entries ADD COLUMN sync_state TEXT NOT NULL DEFAULT 'pending_create';
        UPDATE local_entries
        SET sync_state = CASE WHEN synced = 1 THEN 'synced' ELSE 'pending_create' END;
      ",
        )
        .map_err(db_err)?;
    }
    db.execute_batch(
        "
      UPDATE local_entries
      SET sync_state = CASE WHEN synced = 1 THEN 'synced' ELSE sync_state END
      WHERE sync_state NOT IN ('pending_create', 'pending_update', 'synced')
         OR (synced = 1 AND sync_state <> 'synced');
      CREATE INDEX IF NOT EXISTS idx_local_entries_sync_state ON local_entries(sync_state);
    ",
    )
    .map_err(db_err)
}

fn migrate_ownership(db: &Connection) -> Result<(), TimerError> {
    let names = columns(db)?;
    for (column, ddl) in [
        (
            "owner_user_id",
            "ALTER TABLE local_entries ADD COLUMN owner_user_id TEXT",
        ),
        (
            "owner_workspace_id",
            "ALTER TABLE local_entries ADD COLUMN owner_workspace_id TEXT",
        ),
        (
            "acknowledged_revision",
            "ALTER TABLE local_entries ADD COLUMN acknowledged_revision INTEGER",
        ),
        (
            "acknowledged_hash",
            "ALTER TABLE local_entries ADD COLUMN acknowledged_hash TEXT",
        ),
    ] {
        if !names.iter().any(|name| name == column) {
            db.execute_batch(ddl).map_err(db_err)?;
        }
    }
    db.execute_batch(
        "
      CREATE INDEX IF NOT EXISTS idx_local_entries_owner_open
        ON local_entries(owner_user_id, owner_workspace_id, ended_at);
      CREATE INDEX IF NOT EXISTS idx_local_entries_owner_sync
        ON local_entries(owner_user_id, owner_workspace_id, sync_state);
    ",
    )
    .map_err(db_err)
}
