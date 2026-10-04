//! Boot recovery and server finalization.
//!
//! Port of `recover`, `recoverAway` and `acceptServerFinalization` of
//! `timerService.ts`.

use std::cmp::Ordering;

use super::boundary::safe_close_at;
use super::error::TimerError;
use super::service::TimerService;
use super::types::{TimerRecoveryNotice, TimerRecoveryReason, TimerRecoveryResult};
use crate::js::number::{add, max};
use crate::segments::recover_stale_entry;
use crate::types::{AgentCloseReason, Segment, TimeEntry};

/// `{...recoverStaleEntry(open, recoveredAt), closeReason: 'AGENT_RECOVERY'}`.
fn recovered_entry(open: &TimeEntry, recovered_at: f64) -> Result<TimeEntry, TimerError> {
    let mut recovered = recover_stale_entry(open, recovered_at)?;
    recovered.close_reason = Some(AgentCloseReason::AgentRecovery);
    Ok(recovered)
}

impl TimerService {
    /// Port of `TimerService.recover`: on boot, recover a left-open entry. Time
    /// is trusted only up to `last_known_active_at`.
    pub fn recover(
        &mut self,
        last_known_active_at: f64,
    ) -> Result<Option<TimerRecoveryResult>, TimerError> {
        let Some(open) = self.store.get_open()? else {
            self.store.clear_exit_intent()?;
            return Ok(None);
        };
        let recovered_at = safe_close_at(&open, last_known_active_at);
        let recovered = recovered_entry(&open, recovered_at)?;
        // Persist only; the caller runs flushUnsynced() next.
        self.write_entry(&recovered, None)?;
        self.open = None;
        self.store.clear_exit_intent()?;
        let notice = TimerRecoveryNotice {
            entry_id: recovered.id.clone(),
            recovered_at,
            reason: TimerRecoveryReason::UnexpectedShutdown,
            observed_at: self.clock.now(),
        };
        self.store.set_recovery_notice(&notice)?;
        Ok(Some(TimerRecoveryResult {
            entry_id: recovered.id,
            recovered_at,
            notice,
        }))
    }

    /// Port of `TimerService.recoverAway`. Quirk, copied: when the open entry is
    /// missing or a different one, the away state is cleared and the different
    /// open entry is left open.
    pub fn recover_away(&mut self) -> Result<Option<TimerRecoveryResult>, TimerError> {
        let Some(away) = self.store.get_away_state()? else {
            return Ok(None);
        };
        let notice = self.away_notice(away.reason, &away.entry_id, away.away_started_at);
        let open = self.store.get_open()?;
        let Some(open) = open.filter(|open| open.id == away.entry_id) else {
            if self.store.get_recovery_notice()?.is_none() {
                self.store.set_recovery_notice(&notice)?;
            }
            self.store.clear_away_state()?;
            return Ok(Some(TimerRecoveryResult {
                entry_id: away.entry_id,
                recovered_at: away.away_started_at,
                notice,
            }));
        };
        let recovered_at = safe_close_at(&open, away.away_started_at);
        let recovered = recovered_entry(&open, recovered_at)?;
        self.write_entry(&recovered, None)?;
        self.open = None;
        let recovered_notice = self.away_notice(away.reason, &recovered.id, recovered_at);
        self.store.set_recovery_notice(&recovered_notice)?;
        self.store.clear_away_state()?;
        Ok(Some(TimerRecoveryResult {
            entry_id: recovered.id,
            recovered_at,
            notice: recovered_notice,
        }))
    }

    /// `TimerService.acceptServerFinalization` before its `status()`: accept an
    /// authoritative server finalization and stop the local timer visibly.
    pub(crate) fn accept_server_finalization_step(
        &mut self,
        entry_id: &str,
        ended_at: f64,
    ) -> Result<(), TimerError> {
        let Some(open) = self.open.clone().filter(|open| open.id == entry_id) else {
            return Ok(());
        };
        let boundary = max(open.started_at, ended_at);
        let segments = open
            .segments
            .iter()
            .filter(|segment| segment.started_at <= boundary)
            .map(|segment| Segment {
                ended_at: Some(match segment.ended_at {
                    Some(end) if end.partial_cmp(&boundary) != Some(Ordering::Greater) => end,
                    _ => boundary,
                }),
                ..segment.clone()
            })
            .collect();
        let closed = TimeEntry {
            revision: add(open.revision, 1.0),
            ended_at: Some(boundary),
            pause_reason: None,
            close_reason: Some(AgentCloseReason::Agent),
            segments,
            ..open
        };
        self.write_entry(&closed, None)?;
        self.open = None;
        let observed_at = self.clock.now();
        self.store.set_recovery_notice(&TimerRecoveryNotice {
            entry_id: entry_id.to_owned(),
            recovered_at: boundary,
            reason: TimerRecoveryReason::ServerFinalized,
            observed_at,
        })?;
        self.notify_mutation();
        Ok(())
    }
}
