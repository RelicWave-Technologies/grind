//! The mutating commands: one atomic stretch each.
//!
//! Port of `start`, `stop`, `pause`, `pauseForIdle`, `pauseForPermission`,
//! `resumeFromIdle`, `prepareForQuit`, `prepareForAway`, `discardAway`, the
//! meeting functions and the private `commit*`/`createEntry` of `timerService.ts`.
//! The TypeScript `async` methods end in `return this.status()`; here the step
//! returns `()` and [`super::runtime`] reads the status afterwards, after it has
//! started the queued background syncs, which is the TypeScript order.

use super::boundary::safe_close_at;
use super::error::TimerError;
use super::service::{SyncJob, TimerService};
use super::types::{
    PendingEntrySyncState, StartArgs, TimerAwayReason, TimerAwayState, TimerExitIntent,
    TimerExitReason, TimerRecoveryNotice, TimerRecoveryReason,
};
use crate::js::number::{max, sub};
use crate::segments::{
    CreateArgs, IdleDiscardArgs, OpenSegmentArgs, apply_idle_discard, close_open_segment,
    close_time_entry, create_time_entry, get_open_segment, open_segment,
};
use crate::types::{SegmentKind, TimeEntry, TimeEntryPauseReason, TimeEntrySource};

impl TimerService {
    /// Port of `TimerService.boundaryAgo`: "it happened N ms ago" as an instant
    /// in this module's clock frame. Callers hand durations, never instants.
    pub(super) fn boundary_ago(&self, elapsed_ms: f64) -> f64 {
        let now = self.clock.now();
        sub(now, max(0.0, elapsed_ms))
    }

    /// Port of `TimerService.createEntry`.
    fn create_entry(
        &mut self,
        lark_task_guid: Option<String>,
        started_at: f64,
    ) -> Result<TimeEntry, TimerError> {
        let owner = self
            .store
            .current_owner()
            .ok_or(TimerError::OwnerUnavailable)?;
        let id = self.ids.ulid();
        let client_uuid = self.ids.ulid();
        let segment_id = self.ids.ulid();
        Ok(create_time_entry(&CreateArgs {
            id,
            client_uuid,
            user_id: owner.user_id,
            lark_task_guid,
            source: Some(TimeEntrySource::Auto),
            started_at,
            segment_id,
        }))
    }

    /// Port of `TimerService.notifyMutation`. The call itself is made by the runtime, once
    /// the stretch is over and the service lock is released (a listener may re-enter the
    /// engine); a listener's failure never fails a committed mutation.
    pub(super) fn notify_mutation(&mut self) {
        self.notifications += 1;
    }

    /// Port of `TimerService.syncInBackground`, as a queued request.
    pub(super) fn sync_in_background(&mut self, entry: TimeEntry, state: PendingEntrySyncState) {
        self.outbox.push(SyncJob { entry, state });
    }

    /// Port of `TimerService.commitOpen`.
    fn commit_open(
        &mut self,
        entry: TimeEntry,
        sync_state: Option<PendingEntrySyncState>,
    ) -> Result<(), TimerError> {
        self.committed = true;
        let next_state = self.write_entry(&entry, sync_state)?;
        self.open = Some(entry.clone());
        self.notify_mutation();
        self.sync_in_background(entry, next_state);
        Ok(())
    }

    /// Port of `TimerService.commitClosed`.
    fn commit_closed(&mut self, entry: TimeEntry) -> Result<(), TimerError> {
        self.committed = true;
        let next_state = self.write_entry(&entry, None)?;
        self.open = None;
        self.notify_mutation();
        self.sync_in_background(entry, next_state);
        Ok(())
    }

    /// `TimerService.start`, after `await this.accrualGuard.assertCanAccrue()`.
    pub(crate) fn start_after_guard(&mut self, args: &StartArgs) -> Result<(), TimerError> {
        let now = self.clock.now();
        let next_task_guid = args.lark_task_guid.clone();
        if let Some(open) = self.open.clone() {
            if open.lark_task_guid.clone().flatten() == next_task_guid {
                return Ok(());
            }
            let closed = close_time_entry(&open, now)?;
            let next = self.create_entry(next_task_guid, now)?;
            // Quirk, copied: `switchEntry` does not bump `ledgerEpoch`.
            let (closed_state, next_state) = self.store.switch_entry(&closed, &next)?;
            self.open = Some(next.clone());
            self.notify_mutation();
            self.sync_in_background(closed, closed_state);
            self.sync_in_background(next, next_state);
            return Ok(());
        }
        let entry = self.create_entry(next_task_guid, now)?;
        self.commit_open(entry, Some(PendingEntrySyncState::PendingCreate))
    }

    /// `TimerService.stop`.
    pub(crate) fn stop_step(&mut self) -> Result<(), TimerError> {
        let Some(open) = self.open.clone() else {
            return Ok(());
        };
        let closed = close_time_entry(&open, safe_close_at(&open, self.clock.now()))?;
        self.commit_closed(closed)
    }

    /// `TimerService.prepareForQuit`.
    pub(crate) fn prepare_for_quit_step(
        &mut self,
        reason: TimerExitReason,
    ) -> Result<(), TimerError> {
        let Some(open) = self.open.clone() else {
            return self.store.clear_exit_intent();
        };
        let observed_at = self.clock.now();
        // Quirk, copied: the exit intent is durable but nothing ever reads it.
        self.store.set_exit_intent(&TimerExitIntent {
            reason,
            entry_id: open.id.clone(),
            observed_at,
        })?;
        let closed = close_time_entry(&open, safe_close_at(&open, observed_at))?;
        self.commit_closed(closed)
    }

    /// The end of `TimerService.prepareForQuit`, after `await this.commitClosed(...)`.
    pub(crate) fn clear_exit_intent_step(&mut self) -> Result<(), TimerError> {
        self.store.clear_exit_intent()
    }

    /// `TimerService.prepareForAway`. The order is load-bearing: the away
    /// boundary is durable before memory reports the timer closed.
    pub(crate) fn prepare_for_away_step(
        &mut self,
        reason: TimerAwayReason,
        away_for_ms: f64,
    ) -> Result<(), TimerError> {
        let Some(open) = self.open.clone() else {
            return self.store.clear_away_state();
        };
        let close_at = safe_close_at(&open, self.boundary_ago(away_for_ms));
        let observed_at = self.clock.now();
        self.store.set_away_state(&TimerAwayState {
            reason,
            entry_id: open.id.clone(),
            away_started_at: close_at,
            observed_at,
        })?;
        let closed = close_time_entry(&open, close_at)?;
        let next_state = self.write_entry(&closed, None)?;
        self.open = None;
        let notice = self.away_notice(reason, &closed.id, close_at);
        self.store.set_recovery_notice(&notice)?;
        self.store.clear_away_state()?;
        self.notify_mutation();
        self.sync_in_background(closed, next_state);
        Ok(())
    }

    /// `TimerService.pause`: an explicit user pause.
    pub(crate) fn pause_step(&mut self) -> Result<(), TimerError> {
        let Some(open) = self.open.clone() else {
            return Ok(());
        };
        if get_open_segment(&open).is_none() {
            return Ok(());
        }
        let mut paused = close_open_segment(&open, safe_close_at(&open, self.clock.now()))?;
        paused.pause_reason = Some(TimeEntryPauseReason::Manual);
        self.commit_open(paused, None)
    }

    /// `TimerService.pauseForIdle`: the idle gap is simply not tracked.
    pub(crate) fn pause_for_idle_step(&mut self, idle_for_ms: f64) -> Result<(), TimerError> {
        let Some(open) = self.open.clone() else {
            return Ok(());
        };
        let Some(segment) = get_open_segment(&open) else {
            return Ok(());
        };
        let cut = max(self.boundary_ago(idle_for_ms), segment.started_at);
        let mut paused = close_open_segment(&open, cut)?;
        paused.pause_reason = Some(TimeEntryPauseReason::Idle);
        self.commit_open(paused, None)
    }

    /// `TimerService.pauseForPermission`: freeze at the last healthy proof.
    pub(crate) fn pause_for_permission_step(
        &mut self,
        unhealthy_for_ms: f64,
    ) -> Result<(), TimerError> {
        let Some(open) = self.open.clone() else {
            return Ok(());
        };
        let Some(segment) = get_open_segment(&open) else {
            if open.pause_reason != Some(TimeEntryPauseReason::PermissionRequired) {
                let mut paused = open.clone();
                paused.revision = crate::js::number::add(open.revision, 1.0);
                paused.pause_reason = Some(TimeEntryPauseReason::PermissionRequired);
                self.commit_open(paused, None)?;
            }
            return Ok(());
        };
        let cut = max(segment.started_at, self.boundary_ago(unhealthy_for_ms));
        let mut paused = close_open_segment(&open, cut)?;
        paused.pause_reason = Some(TimeEntryPauseReason::PermissionRequired);
        self.commit_open(paused, None)
    }

    /// The synchronous prefix of `TimerService.resumeFromIdle` (before its
    /// guard await): true when it would go on to the guard.
    #[must_use]
    pub(crate) fn resume_needs_guard(&self) -> bool {
        self.open
            .as_ref()
            .is_some_and(|open| get_open_segment(open).is_none())
    }

    /// `TimerService.resumeFromIdle`, after its guard await. `this.open` is read
    /// again here: `stop()` may have run during the await, which makes the
    /// TypeScript throw V8's `TypeError` (after consuming an id).
    pub(crate) fn resume_after_guard(&mut self, at: f64) -> Result<(), TimerError> {
        self.open_kind_after_guard(SegmentKind::Work, max(at, self.clock.now()))
    }

    /// `openSegment(this.open, { kind, at, segmentId: this.ids.ulid() })` then
    /// `commitOpen`, in the TypeScript's evaluation order.
    fn open_kind_after_guard(&mut self, kind: SegmentKind, at: f64) -> Result<(), TimerError> {
        let open = self.open.clone();
        let segment_id = self.ids.ulid();
        let open = open.ok_or(TimerError::NullEntry)?;
        let resumed = open_segment(
            &open,
            &OpenSegmentArgs {
                kind,
                at,
                segment_id,
            },
        )?;
        self.commit_open(resumed, None)
    }

    /// `TimerService.discardAway`'s synchronous prefix: the open segment's
    /// start when the guard is next. [dead in production]
    #[must_use]
    pub(crate) fn discard_away_needs_guard(&self, away_start: f64, resume_at: f64) -> Option<f64> {
        let open = self.open.as_ref()?;
        if sub(resume_at, away_start) < 1000.0 {
            return None;
        }
        get_open_segment(open).map(|segment| segment.started_at)
    }

    /// `TimerService.discardAway` after the guard; `segment_started_at` is the
    /// value read before it. [dead in production]
    pub(crate) fn discard_away_after_guard(
        &mut self,
        away_start: f64,
        resume_at: f64,
        segment_started_at: f64,
    ) -> Result<(), TimerError> {
        let open = self.open.clone();
        let idle_started_at = max(away_start, segment_started_at);
        let idle_segment_id = self.ids.ulid();
        let work_segment_id = self.ids.ulid();
        let open = open.ok_or(TimerError::NullEntry)?;
        let updated = apply_idle_discard(
            &open,
            &IdleDiscardArgs {
                idle_started_at,
                resume_at,
                idle_segment_id,
                work_segment_id,
            },
        )?;
        self.commit_open(updated, None)
    }

    /// `beginMeeting`/`endMeeting` synchronous prefix: true when the guard is
    /// next. [dead in production]
    #[must_use]
    pub(crate) fn meeting_needs_guard(&self, from: SegmentKind) -> bool {
        self.open.as_ref().is_some_and(|open| {
            get_open_segment(open).is_some_and(|s| match from {
                SegmentKind::Work => s.kind != SegmentKind::Meeting,
                _ => s.kind == SegmentKind::Meeting,
            })
        })
    }

    /// `beginMeeting`/`endMeeting` after the guard. [dead in production]
    pub(crate) fn meeting_after_guard(
        &mut self,
        kind: SegmentKind,
        at: f64,
    ) -> Result<(), TimerError> {
        self.open_kind_after_guard(kind, at)
    }

    /// `TimerService.awayNotice`.
    pub(super) fn away_notice(
        &self,
        reason: TimerAwayReason,
        entry_id: &str,
        recovered_at: f64,
    ) -> TimerRecoveryNotice {
        TimerRecoveryNotice {
            entry_id: entry_id.to_owned(),
            recovered_at,
            reason: match reason {
                TimerAwayReason::Suspend => TimerRecoveryReason::SleepStop,
                TimerAwayReason::Lock => TimerRecoveryReason::LockStop,
            },
            observed_at: self.clock.now(),
        }
    }
}
