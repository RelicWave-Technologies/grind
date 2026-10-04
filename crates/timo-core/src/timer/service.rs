//! The timer orchestrator, minus its yield points.
//!
//! Port of `legacy/agent/src/main/services/timer/timerService.ts::TimerService`.
//! This type is the synchronous, lock-free-of-await half: every method is one
//! atomic stretch of the TypeScript (the code between two `await`s). The awaits
//! (the accrual guard, the sync round trips) live in [`super::runtime`], which
//! owns a `TimerService` behind a mutex and never holds it across one. See
//! `CONCURRENCY.md` for the mapping, one row per TypeScript `await`.

use std::sync::Arc;

use super::defaults::{EmptyServerCache, UtcDayProvider};
use super::error::TimerError;
use super::ledger_memo::LedgerMemo;
use super::traits::{BusinessDayProvider, Clock, EntryStore, IdGen, ServerLedgerCache};
use super::types::{
    EntryMatch, PendingEntrySyncState, ReadRecoveryNotice, TimerOwner, TodayLedgerMode,
};
use crate::segments::get_open_segment;
use crate::types::TimeEntry;

/// `mutationListener`: called by the runtime with no lock held, so it may call straight back
/// into the engine.
pub type MutationListener = Arc<dyn Fn() + Send + Sync>;

/// A background sync the runtime must start: `syncInBackground(entry, state)`.
#[derive(Debug, Clone, PartialEq)]
pub struct SyncJob {
    pub entry: TimeEntry,
    pub state: PendingEntrySyncState,
}

/// `{ localMs, mergedMs, conflicts }` of `todayLedgerDiagnostics`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TodayLedgerDiagnostics {
    pub local_ms: f64,
    pub merged_ms: f64,
    pub conflicts: usize,
}

/// Port of `TimerService`.
pub struct TimerService {
    pub(super) store: Box<dyn EntryStore>,
    pub(super) clock: Arc<dyn Clock>,
    pub(super) ids: Box<dyn IdGen>,
    pub(super) business_day: Box<dyn BusinessDayProvider>,
    pub(super) server_cache: Box<dyn ServerLedgerCache>,
    pub(super) open: Option<TimeEntry>,
    /// Bumped by every durable write the wrappers make; keys the ledger memo.
    pub(super) ledger_epoch: u64,
    pub(super) mutation_listener: Option<MutationListener>,
    /// `notifyMutation` calls made since the runtime last drained them: the runtime calls
    /// the listener, after it has released the service lock.
    pub(super) notifications: u32,
    /// Set when a stretch reached `commitOpen`/`commitClosed`: the TypeScript `await`s them.
    pub(super) committed: bool,
    pub(super) today_ledger_mode: TodayLedgerMode,
    pub(super) memo: Option<LedgerMemo>,
    /// `syncInBackground` calls made since the runtime last drained them.
    pub(super) outbox: Vec<SyncJob>,
}

impl std::fmt::Debug for TimerService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TimerService")
            .field("open", &self.open)
            .field("ledger_epoch", &self.ledger_epoch)
            .field("today_ledger_mode", &self.today_ledger_mode)
            .finish_non_exhaustive()
    }
}

impl TimerService {
    /// Port of the constructor, with the TypeScript's default business day
    /// (`UTC_DAY_PROVIDER`) and server cache (`EMPTY_SERVER_CACHE`).
    #[must_use]
    pub fn new(store: Box<dyn EntryStore>, clock: Arc<dyn Clock>, ids: Box<dyn IdGen>) -> Self {
        Self {
            store,
            clock,
            ids,
            business_day: Box::new(UtcDayProvider),
            server_cache: Box::new(EmptyServerCache),
            open: None,
            ledger_epoch: 0,
            mutation_listener: None,
            notifications: 0,
            committed: false,
            today_ledger_mode: TodayLedgerMode::Off,
            memo: None,
            outbox: Vec::new(),
        }
    }

    /// The constructor's sixth argument.
    #[must_use]
    pub fn with_business_day(mut self, business_day: Box<dyn BusinessDayProvider>) -> Self {
        self.business_day = business_day;
        self
    }

    /// The constructor's seventh argument.
    #[must_use]
    pub fn with_server_cache(mut self, server_cache: Box<dyn ServerLedgerCache>) -> Self {
        self.server_cache = server_cache;
        self
    }

    /// Port of `TimerService.bindOwner`. Switching sessions never rewrites or
    /// uploads the previous owner's row.
    pub fn bind_owner(
        &mut self,
        owner: Option<&TimerOwner>,
        claim_legacy: bool,
    ) -> Result<(), TimerError> {
        self.store.bind_owner(owner.cloned());
        if let (Some(owner), true) = (owner, claim_legacy) {
            self.store.claim_unowned_entries(owner)?;
        }
        self.open = self.store.get_open()?;
        Ok(())
    }

    /// Port of `TimerService.currentOwner`.
    #[must_use]
    pub fn current_owner(&self) -> Option<TimerOwner> {
        self.store.current_owner()
    }

    /// Port of `TimerService.claimServerMatchedEntries`.
    pub fn claim_server_matched_entries(
        &mut self,
        matches: &[EntryMatch],
    ) -> Result<usize, TimerError> {
        let Some(owner) = self.store.current_owner() else {
            return Ok(0);
        };
        self.store.claim_server_matched_entries(&owner, matches)
    }

    /// Port of `TimerService.setMutationListener`.
    pub fn set_mutation_listener(&mut self, listener: Option<MutationListener>) {
        self.mutation_listener = listener;
    }

    /// Port of `TimerService.setTodayLedgerMode`: true when it changed.
    pub fn set_today_ledger_mode(&mut self, mode: TodayLedgerMode) -> bool {
        if self.today_ledger_mode == mode {
            return false;
        }
        self.today_ledger_mode = mode;
        true
    }

    /// Port of `TimerService.isRunning`.
    #[must_use]
    pub const fn is_running(&self) -> bool {
        self.open.is_some()
    }

    /// Port of `TimerService.isPaused`: running but paused.
    #[must_use]
    pub fn is_paused(&self) -> bool {
        self.open
            .as_ref()
            .is_some_and(|open| get_open_segment(open).is_none())
    }

    /// Port of `TimerService.heartbeat`: a "still alive" proof, bounding crash
    /// recovery. A no-op when nothing is open.
    pub fn heartbeat(&mut self) -> Result<(), TimerError> {
        if self.open.is_none() {
            return Ok(());
        }
        let now = self.clock.now();
        self.store.set_liveness(now)
    }

    /// Port of `TimerService.lastLiveness`.
    pub fn last_liveness(&self) -> Result<Option<f64>, TimerError> {
        self.store.get_liveness()
    }

    /// Port of `TimerService.recoveryNotice`.
    pub fn recovery_notice(&self) -> Result<Option<ReadRecoveryNotice>, TimerError> {
        self.store.get_recovery_notice()
    }

    /// Port of `TimerService.dismissRecoveryNotice`.
    pub fn dismiss_recovery_notice(&mut self) -> Result<(), TimerError> {
        self.store.clear_recovery_notice()
    }

    /// Port of `TimerService.hasUnsynced`.
    pub fn has_unsynced(&self) -> Result<bool, TimerError> {
        self.store.has_unsynced()
    }

    /// Port of `TimerService.isPendingCreate`.
    pub fn is_pending_create(&self, entry_id: &str) -> Result<bool, TimerError> {
        self.store.is_pending_create(entry_id)
    }

    /// Port of `TimerService.isInMeetingSegment`.
    #[must_use]
    pub fn is_in_meeting_segment(&self) -> bool {
        self.open.as_ref().is_some_and(|open| {
            get_open_segment(open).is_some_and(|s| s.kind == crate::types::SegmentKind::Meeting)
        })
    }

    /// The listener and how many times to call it, for the stretch that just ended.
    pub(crate) fn take_notifications(&mut self) -> Option<(MutationListener, u32)> {
        let count = std::mem::take(&mut self.notifications);
        self.mutation_listener
            .clone()
            .filter(|_| count > 0)
            .map(|listener| (listener, count))
    }

    /// Whether the stretch that just ended reached a `commit*` (which is awaited).
    pub(crate) fn take_committed(&mut self) -> bool {
        std::mem::take(&mut self.committed)
    }

    /// Drain the background syncs queued by the last mutation.
    pub(crate) fn take_outbox(&mut self) -> Vec<SyncJob> {
        std::mem::take(&mut self.outbox)
    }

    /// The `store.getUnsynced()` snapshot `flushUnsynced` iterates.
    pub(crate) fn unsynced(&self) -> Result<Vec<super::types::UnsyncedEntry>, TimerError> {
        self.store.get_unsynced()
    }
}
