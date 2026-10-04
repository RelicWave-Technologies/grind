//! The durable entry journal.
//!
//! Port of `legacy/agent/src/main/services/timer/sqliteStore.ts::SqliteEntryStore`.
//! Each entry is a JSON blob with indexed columns (`ended_at`, `synced`,
//! `sync_state`) for the hot queries; WAL + `synchronous = FULL` make an
//! acknowledged write survive a crash. The method bodies live next to the SQL
//! they run (`entry_rows`, `writes`, `claim`, `meta`); this file is the trait.

use timo_core::timer::TimerError;
use timo_core::timer::traits::EntryStore;
use timo_core::timer::types::{
    Acknowledgement, EntryMatch, PendingEntrySyncState, ReadRecoveryNotice, TimerAwayState,
    TimerExitIntent, TimerOwner, TimerRecoveryNotice, UnsyncedEntry,
};
use timo_core::today_ledger::LocalLedgerEntry;
use timo_core::types::TimeEntry;

use super::db::{SharedDb, lock};
use super::migrations::prepare_entry_tables;

/// Port of `SqliteEntryStore`.
#[derive(Debug)]
pub struct SqliteEntryStore {
    pub(super) db: SharedDb,
    pub(super) owner: Option<TimerOwner>,
}

impl SqliteEntryStore {
    /// Port of the constructor: PRAGMAs, tables, migrations.
    pub fn new(db: SharedDb) -> Result<Self, TimerError> {
        prepare_entry_tables(&lock(&db))?;
        Ok(Self { db, owner: None })
    }

    /// `requireOwner()`.
    pub(super) fn require_owner(&self) -> Result<&TimerOwner, TimerError> {
        self.owner.as_ref().ok_or(TimerError::OwnerUnavailable)
    }

    /// `ownerMetaKey(owner, key)`.
    pub(super) fn meta_key(owner: &TimerOwner, key: &str) -> String {
        format!("{}:{}:{key}", owner.workspace_id, owner.user_id)
    }
}

impl EntryStore for SqliteEntryStore {
    fn bind_owner(&mut self, owner: Option<TimerOwner>) {
        self.owner = owner;
    }

    fn current_owner(&self) -> Option<TimerOwner> {
        self.owner.clone()
    }

    fn claim_unowned_entries(&mut self, owner: &TimerOwner) -> Result<usize, TimerError> {
        self.claim_unowned(owner)
    }

    fn claim_server_matched_entries(
        &mut self,
        owner: &TimerOwner,
        matches: &[EntryMatch],
    ) -> Result<usize, TimerError> {
        self.claim_matched(owner, matches)
    }

    fn upsert(
        &mut self,
        entry: &TimeEntry,
        sync_state: Option<PendingEntrySyncState>,
    ) -> Result<PendingEntrySyncState, TimerError> {
        self.upsert_entry(entry, sync_state)
    }

    fn switch_entry(
        &mut self,
        closed: &TimeEntry,
        next: &TimeEntry,
    ) -> Result<(PendingEntrySyncState, PendingEntrySyncState), TimerError> {
        self.switch(closed, next)
    }

    fn get_open(&self) -> Result<Option<TimeEntry>, TimerError> {
        self.open_entry()
    }

    fn get_unsynced(&self) -> Result<Vec<UnsyncedEntry>, TimerError> {
        self.unsynced_entries()
    }

    fn has_unsynced(&self) -> Result<bool, TimerError> {
        self.any_unsynced()
    }

    fn is_pending_create(&self, entry_id: &str) -> Result<bool, TimerError> {
        Ok(self.sync_state_of(entry_id)?
            == Some(timo_core::timer::types::EntrySyncState::PendingCreate))
    }

    fn list_recent(&self, limit: f64) -> Result<Vec<TimeEntry>, TimerError> {
        self.recent(limit)
    }

    fn list_since(&self, since: f64) -> Result<Vec<TimeEntry>, TimerError> {
        self.since(since)
    }

    fn list_ledger_entries(&self, since: f64) -> Result<Vec<LocalLedgerEntry>, TimerError> {
        self.ledger_entries(since)
    }

    fn mark_created(&mut self, entry_id: &str, expected: &TimeEntry) -> Result<bool, TimerError> {
        self.mark_created_impl(entry_id, expected)
    }

    fn mark_pending_create(
        &mut self,
        entry_id: &str,
        expected: &TimeEntry,
    ) -> Result<bool, TimerError> {
        self.mark_pending_create_impl(entry_id, expected)
    }

    fn mark_synced(
        &mut self,
        entry_id: &str,
        expected: &TimeEntry,
        acknowledgement: &Acknowledgement,
    ) -> Result<bool, TimerError> {
        self.mark_synced_impl(entry_id, expected, acknowledgement)
    }

    fn set_liveness(&mut self, ts: f64) -> Result<(), TimerError> {
        self.write_liveness(ts)
    }

    fn get_liveness(&self) -> Result<Option<f64>, TimerError> {
        self.read_liveness()
    }

    fn set_exit_intent(&mut self, intent: &TimerExitIntent) -> Result<(), TimerError> {
        self.set_json_meta("exit_intent", intent)
    }

    fn get_exit_intent(&self) -> Result<Option<TimerExitIntent>, TimerError> {
        Ok(self
            .get_json_meta("exit_intent")?
            .as_ref()
            .and_then(super::parse::as_exit_intent))
    }

    fn clear_exit_intent(&mut self) -> Result<(), TimerError> {
        self.delete_meta("exit_intent")
    }

    fn set_away_state(&mut self, state: &TimerAwayState) -> Result<(), TimerError> {
        self.set_json_meta("away_state", state)
    }

    fn get_away_state(&self) -> Result<Option<TimerAwayState>, TimerError> {
        Ok(self
            .get_json_meta("away_state")?
            .as_ref()
            .and_then(super::parse::as_away_state))
    }

    fn clear_away_state(&mut self) -> Result<(), TimerError> {
        self.delete_meta("away_state")
    }

    fn set_recovery_notice(&mut self, notice: &TimerRecoveryNotice) -> Result<(), TimerError> {
        self.set_json_meta("recovery_notice", notice)
    }

    fn get_recovery_notice(&self) -> Result<Option<ReadRecoveryNotice>, TimerError> {
        Ok(self
            .get_json_meta("recovery_notice")?
            .as_ref()
            .and_then(super::parse::as_recovery_notice))
    }

    fn clear_recovery_notice(&mut self) -> Result<(), TimerError> {
        self.delete_meta("recovery_notice")
    }
}
