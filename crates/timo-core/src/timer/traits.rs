//! The seams the timer engine reaches the world through.
//!
//! Port of `legacy/agent/src/main/services/timer/types.ts` (the interfaces).
//! Everything with a side effect or a clock is injected, exactly as in the
//! TypeScript, so the engine is deterministic under a fake clock.

use futures_util::future::BoxFuture;

use super::dto::TimerSyncReceipt;
use super::error::{GuardError, SyncError, TimerError};
use super::types::{
    Acknowledgement, DayWindow, EntryMatch, PendingEntrySyncState, ReadRecoveryNotice,
    TimerAwayState, TimerExitIntent, TimerOwner, TimerRecoveryNotice, UnsyncedEntry,
};
use crate::today_ledger::{LocalLedgerEntry, ServerLedgerEntry};
use crate::types::TimeEntry;

/// Port of `types.ts::Clock`. Epoch milliseconds, usually fractional.
pub trait Clock: Send + Sync {
    fn now(&self) -> f64;
}

/// Port of `types.ts::IdGen`.
pub trait IdGen: Send {
    fn ulid(&mut self) -> String;
}

/// Port of `types.ts::BusinessDayProvider`: `None` is the workspace time zone
/// being unavailable.
pub trait BusinessDayProvider: Send {
    fn window(&self, now: f64) -> Option<DayWindow>;
}

/// Port of `types.ts::ServerLedgerCache`. An `Err` is what the TypeScript lets throw (a
/// failed query); a cache whose rows cannot be parsed is `Ok` and empty.
pub trait ServerLedgerCache: Send {
    fn list(
        &self,
        owner: &TimerOwner,
        window: DayWindow,
        now: f64,
    ) -> Result<Vec<ServerLedgerEntry>, TimerError>;
}

/// Port of `types.ts::TrackingAccrualGuard`. A yield point: the engine awaits it
/// with no lock held and samples the clock only afterwards.
pub trait TrackingAccrualGuard: Send + Sync {
    fn assert_can_accrue(&self) -> BoxFuture<'_, Result<(), GuardError>>;
}

/// Port of `types.ts::SyncClient`. Everything synchronous (building the request
/// body, which for an open entry samples the server clock) happens when the
/// method is called, as in the TypeScript; the returned future is only the
/// network round trip.
pub trait SyncClient: Send + Sync {
    /// Create the entry server-side (idempotent on clientUuid).
    fn create(&self, entry: &TimeEntry) -> BoxFuture<'static, Result<TimerSyncReceipt, SyncError>>;
    /// Replace the entry's segments / close it server-side (idempotent).
    fn sync(&self, entry: &TimeEntry) -> BoxFuture<'static, Result<TimerSyncReceipt, SyncError>>;
}

/// Port of `types.ts::EntryStore`: durable local persistence.
pub trait EntryStore: Send {
    fn bind_owner(&mut self, owner: Option<TimerOwner>);
    fn current_owner(&self) -> Option<TimerOwner>;
    /// Upgrade only rows already naming the authenticated user.
    fn claim_unowned_entries(&mut self, owner: &TimerOwner) -> Result<usize, TimerError>;
    /// Claim only legacy rows whose exact id/client UUID the server proves.
    fn claim_server_matched_entries(
        &mut self,
        owner: &TimerOwner,
        matches: &[EntryMatch],
    ) -> Result<usize, TimerError>;
    /// Persist (insert or replace) an entry and return the local sync state.
    fn upsert(
        &mut self,
        entry: &TimeEntry,
        sync_state: Option<PendingEntrySyncState>,
    ) -> Result<PendingEntrySyncState, TimerError>;
    /// Atomically close the old task and create the replacement task.
    fn switch_entry(
        &mut self,
        closed: &TimeEntry,
        next: &TimeEntry,
    ) -> Result<(PendingEntrySyncState, PendingEntrySyncState), TimerError>;
    fn get_open(&self) -> Result<Option<TimeEntry>, TimerError>;
    fn get_unsynced(&self) -> Result<Vec<UnsyncedEntry>, TimerError>;
    fn has_unsynced(&self) -> Result<bool, TimerError>;
    fn is_pending_create(&self, entry_id: &str) -> Result<bool, TimerError>;
    fn list_recent(&self, limit: f64) -> Result<Vec<TimeEntry>, TimerError>;
    fn list_since(&self, since: f64) -> Result<Vec<TimeEntry>, TimerError>;
    fn list_ledger_entries(&self, since: f64) -> Result<Vec<LocalLedgerEntry>, TimerError>;
    /// Mark this exact snapshot as created remotely.
    fn mark_created(&mut self, entry_id: &str, expected: &TimeEntry) -> Result<bool, TimerError>;
    /// Mark this exact snapshot as requiring a create retry.
    fn mark_pending_create(
        &mut self,
        entry_id: &str,
        expected: &TimeEntry,
    ) -> Result<bool, TimerError>;
    /// Mark an entry as successfully synced if the stored JSON still matches.
    fn mark_synced(
        &mut self,
        entry_id: &str,
        expected: &TimeEntry,
        acknowledgement: &Acknowledgement,
    ) -> Result<bool, TimerError>;
    /// Durable "last proof of life" timestamp.
    fn set_liveness(&mut self, ts: f64) -> Result<(), TimerError>;
    fn get_liveness(&self) -> Result<Option<f64>, TimerError>;
    fn set_exit_intent(&mut self, intent: &TimerExitIntent) -> Result<(), TimerError>;
    fn get_exit_intent(&self) -> Result<Option<TimerExitIntent>, TimerError>;
    fn clear_exit_intent(&mut self) -> Result<(), TimerError>;
    fn set_away_state(&mut self, state: &TimerAwayState) -> Result<(), TimerError>;
    fn get_away_state(&self) -> Result<Option<TimerAwayState>, TimerError>;
    fn clear_away_state(&mut self) -> Result<(), TimerError>;
    fn set_recovery_notice(&mut self, notice: &TimerRecoveryNotice) -> Result<(), TimerError>;
    fn get_recovery_notice(&self) -> Result<Option<ReadRecoveryNotice>, TimerError>;
    fn clear_recovery_notice(&mut self) -> Result<(), TimerError>;
}
