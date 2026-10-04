//! The memoised day-ledger read.
//!
//! Port of `timerService.ts` `ledgerMemo`, `localLedgerEntries` and the
//! `writeEntry`/`markEntry*` wrappers. ONLY the read is memoised, never a total.

use super::error::TimerError;
use super::service::TimerService;
use super::types::{Acknowledgement, PendingEntrySyncState};
use crate::js::number::{strict_eq, sub};
use crate::today_ledger::LocalLedgerEntry;
use crate::types::TimeEntry;

/// Backstop only: correctness comes from `ledgerEpoch`, not from this.
const LEDGER_MEMO_TTL_MS: f64 = 10_000.0;

/// `ledgerMemo`: `{ epoch, windowStart, readAt, rows }`.
#[derive(Debug, Clone)]
pub struct LedgerMemo {
    epoch: u64,
    window_start: f64,
    read_at: f64,
    rows: Vec<LocalLedgerEntry>,
}

impl TimerService {
    /// Port of `TimerService.localLedgerEntries`.
    pub(super) fn local_ledger_entries(
        &mut self,
        window_start: f64,
    ) -> Result<Vec<LocalLedgerEntry>, TimerError> {
        if let Some(memo) = &self.memo
            && memo.epoch == self.ledger_epoch
            && strict_eq(memo.window_start, window_start)
            && sub(self.clock.now(), memo.read_at) < LEDGER_MEMO_TTL_MS
        {
            return Ok(memo.rows.clone());
        }
        let rows = self.store.list_ledger_entries(window_start)?;
        self.memo = Some(LedgerMemo {
            epoch: self.ledger_epoch,
            window_start,
            read_at: self.clock.now(),
            rows: rows.clone(),
        });
        Ok(rows)
    }

    /// Port of `TimerService.writeEntry`: every durable entry write goes
    /// through here (or the three below), so the memo cannot go stale.
    pub(super) fn write_entry(
        &mut self,
        entry: &TimeEntry,
        sync_state: Option<PendingEntrySyncState>,
    ) -> Result<PendingEntrySyncState, TimerError> {
        self.ledger_epoch += 1;
        self.store.upsert(entry, sync_state)
    }

    /// Port of `TimerService.markEntryCreated`.
    pub(super) fn mark_entry_created(&mut self, entry: &TimeEntry) -> Result<bool, TimerError> {
        self.ledger_epoch += 1;
        self.store.mark_created(&entry.id, entry)
    }

    /// Port of `TimerService.markEntryPendingCreate`.
    pub(crate) fn mark_entry_pending_create(
        &mut self,
        entry: &TimeEntry,
    ) -> Result<bool, TimerError> {
        self.ledger_epoch += 1;
        self.store.mark_pending_create(&entry.id, entry)
    }

    /// Port of `TimerService.markEntrySynced`.
    pub(super) fn mark_entry_synced(
        &mut self,
        entry: &TimeEntry,
        acknowledgement: &Acknowledgement,
    ) -> Result<bool, TimerError> {
        self.ledger_epoch += 1;
        self.store.mark_synced(&entry.id, entry, acknowledgement)
    }
}
