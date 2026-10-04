//! Acknowledging a server receipt.
//!
//! Port of `TimerService.acknowledge` and the receipt-handling halves of
//! `tryCreateThenSync`/`tryUpdate` (the halves between two awaits).

use super::dto::{TimerSyncCorrection, TimerSyncDisposition, TimerSyncReceipt, iso_ms};
use super::error::TimerError;
use super::hash::canonical_entry_hash;
use super::service::TimerService;
use super::types::{Acknowledgement, TimerRecoveryNotice, TimerRecoveryReason};
use crate::js::number::strict_eq;
use crate::types::TimeEntry;

impl TimerService {
    /// Port of `TimerService.acknowledge`. `false` changes nothing: the entry
    /// stays pending and the drain retries it. Quirk, copied: the agent hashes
    /// fractional stamps while the server hashes ISO-parsed integer ms, so an
    /// exact match needs integral stamps.
    pub(crate) fn acknowledge(
        &mut self,
        entry: &TimeEntry,
        receipt: &TimerSyncReceipt,
    ) -> Result<bool, TimerError> {
        let local_hash = canonical_entry_hash(entry)?;
        let exact = strict_eq(receipt.accepted_revision, entry.revision)
            && receipt.canonical_hash == local_hash;
        let corrected = receipt.accepted_revision >= entry.revision
            && (receipt.correction.is_some()
                || matches!(
                    receipt.disposition,
                    TimerSyncDisposition::Finalized | TimerSyncDisposition::Stale
                ));
        if !exact && !corrected {
            return Ok(false);
        }
        let marked = self.mark_entry_synced(
            entry,
            &Acknowledgement {
                revision: receipt.accepted_revision,
                hash: receipt.canonical_hash.clone(),
            },
        )?;
        if marked && receipt.correction == Some(TimerSyncCorrection::ClockClamp) {
            let at = receipt
                .canonical_entry
                .ended_at
                .as_deref()
                .unwrap_or(&receipt.server_time);
            let corrected_at = iso_ms(at)?;
            let recovered_at = if corrected_at.is_finite() {
                corrected_at
            } else {
                self.clock.now()
            };
            let observed_at = self.clock.now();
            self.store.set_recovery_notice(&TimerRecoveryNotice {
                entry_id: entry.id.clone(),
                recovered_at,
                reason: TimerRecoveryReason::ServerClockCorrected,
                observed_at,
            })?;
        }
        Ok(marked)
    }

    /// The part of `tryCreateThenSync` after `await sync.create()`: `true` when
    /// the follow-up `tryUpdate(entry, false)` should run.
    pub(crate) fn after_create_receipt(
        &mut self,
        entry: &TimeEntry,
        receipt: &TimerSyncReceipt,
    ) -> Result<bool, TimerError> {
        if self.acknowledge(entry, receipt)? {
            return Ok(false);
        }
        self.mark_entry_created(entry)
    }
}
