//! 1:1 port of `timerService.test.ts`, part 2: offline behaviour, discardAway,
//! pauseForIdle / resumeFromIdle and the meeting segments.
#![allow(
    clippy::float_cmp,
    clippy::float_arithmetic,
    clippy::unwrap_used,
    reason = "the ported tests compare the exact doubles the TypeScript tests compare, with the same arithmetic"
)]

mod timer_support;

use std::sync::Arc;

use timer_support::{Fixture, MIN, T0, is_blocked, is_idle, running};
use timo_core::timer::types::PendingEntrySyncState;
use timo_core::types::TimeEntry;
use timo_core::{Segment, TimeEntryPauseReason, total_worked_ms};

fn pending_states(f: &Fixture) -> Vec<PendingEntrySyncState> {
    f.store.unsynced().iter().map(|u| u.sync_state).collect()
}

mod timer_service_offline_behaviour {
    use super::*;

    #[test]
    fn keeps_the_timer_working_when_create_sync_fails_and_retries_via_flush() {
        let f = Fixture::new();
        f.sync.log().fail_create_count = 1.0; // the create POST fails
        f.start_ok(None);
        assert!(f.svc.lock().is_running()); // timer unaffected by network
        assert_eq!(f.sync.creates().len(), 0);
        assert_eq!(
            pending_states(&f),
            vec![PendingEntrySyncState::PendingCreate]
        );

        // Network recovers; flush retries.
        f.flush(25.0).unwrap();
        assert_eq!(f.sync.creates().len(), 1);
        assert_eq!(f.sync.syncs().len(), 1);
        assert_eq!(f.store.unsynced().len(), 0);
    }

    #[test]
    fn flushes_at_most_one_batch_per_call_and_reports_that_work_remains() {
        let f = Fixture::new();
        f.sync.log().fail_create_count = f64::INFINITY;
        for i in 0..4 {
            f.start_ok(Some(&format!("task-{i}")));
            f.clock.advance(MIN);
            f.stop().unwrap();
        }
        let queued = f.store.unsynced().len();
        assert!(queued > 2);

        f.sync.log().fail_create_count = 0.0;
        let more_remaining = f.flush(2.0).unwrap();

        assert!(more_remaining);
        assert_eq!(f.store.unsynced().len(), queued - 2);
    }

    #[test]
    fn reports_an_empty_backlog_once_the_last_entry_drains() {
        let f = Fixture::new();
        f.sync.log().fail_create_count = 1.0;
        f.start_ok(None);
        assert_eq!(f.store.unsynced().len(), 1);

        assert!(!f.flush(10.0).unwrap());
        assert_eq!(f.store.unsynced().len(), 0);
    }

    #[test]
    fn does_not_ask_for_another_pass_over_an_entry_that_will_not_sync() {
        let f = Fixture::new();
        f.sync.log().fail_create_count = f64::INFINITY;
        f.start_ok(None);
        assert_eq!(f.store.unsynced().len(), 1);

        assert!(!f.flush(10.0).unwrap());
        assert_eq!(f.store.unsynced().len(), 1);
    }

    #[test]
    fn creates_then_closes_an_entry_that_was_started_and_stopped_offline() {
        let f = Fixture::new();
        f.sync.log().fail_create_count = 2.0;
        f.start_ok(None);
        f.clock.advance(10.0 * MIN);
        f.stop().unwrap();
        let entry = f.store.all().remove(0);
        assert_eq!(entry.ended_at, Some(T0 + 10.0 * MIN));
        assert_eq!(
            pending_states(&f),
            vec![PendingEntrySyncState::PendingCreate]
        );

        f.flush(25.0).unwrap();

        assert_eq!(
            f.sync.calls(),
            vec![format!("create:{}", entry.id), format!("sync:{}", entry.id)]
        );
        assert_eq!(f.store.unsynced().len(), 0);
    }

    #[test]
    fn downgrades_a_pending_update_that_404s_and_recreates_it_once() {
        let f = Fixture::new();
        f.start_ok(None);
        let entry = f.store.open().unwrap();
        assert_eq!(f.store.unsynced().len(), 0);

        f.clock.advance(5.0 * MIN);
        f.sync.log().not_found_sync_count = 1.0;
        f.pause_for_idle(0.0).unwrap();
        f.flush(25.0).unwrap();

        let calls = f.sync.calls();
        assert_eq!(
            calls[calls.len() - 2..],
            [format!("create:{}", entry.id), format!("sync:{}", entry.id)]
        );
        assert_eq!(f.store.unsynced().len(), 0);
    }

    #[test]
    fn keeps_pending_update_when_create_succeeds_but_follow_up_sync_fails() {
        let f = Fixture::new();
        f.sync.log().fail_create_count = 1.0;
        f.start_ok(None);
        assert_eq!(
            pending_states(&f),
            vec![PendingEntrySyncState::PendingCreate]
        );

        f.sync.log().fail_sync_count = 1.0;
        f.flush(25.0).unwrap();

        assert_eq!(f.sync.creates().len(), 1);
        assert_eq!(f.sync.syncs().len(), 0);
        assert_eq!(
            pending_states(&f),
            vec![PendingEntrySyncState::PendingUpdate]
        );

        f.flush(25.0).unwrap();
        assert_eq!(f.sync.syncs().len(), 1);
        assert_eq!(f.store.unsynced().len(), 0);
    }

    #[test]
    fn does_not_upgrade_a_pending_create_row_to_pending_update_when_mutated_locally() {
        let f = Fixture::new();
        f.sync.log().fail_create_count = 2.0;
        f.start_ok(None);
        assert_eq!(
            pending_states(&f),
            vec![PendingEntrySyncState::PendingCreate]
        );

        f.clock.advance(5.0 * MIN);
        f.pause_for_idle(0.0).unwrap();

        assert_eq!(
            pending_states(&f),
            vec![PendingEntrySyncState::PendingCreate]
        );
        assert_eq!(f.sync.syncs().len(), 0);
    }

    #[test]
    fn does_not_mark_a_newer_local_mutation_synced_when_an_older_update_finishes() {
        let f = Fixture::new();
        f.start_ok(None);
        let store = f.store.clone();
        f.sync.log().on_sync = Some(Arc::new(move |e: &TimeEntry| {
            let mut changed = e.clone();
            changed.segments = vec![Segment {
                ended_at: Some(T0 + 2.0 * MIN),
                ..e.segments[0].clone()
            }];
            store.put(&changed);
        }));

        f.clock.advance(MIN);
        f.pause_for_idle(0.0).unwrap();

        assert_eq!(
            pending_states(&f),
            vec![PendingEntrySyncState::PendingUpdate]
        );
    }

    #[test]
    fn ignores_a_stale_create_response_when_local_state_changes_in_flight() {
        let f = Fixture::new();
        f.sync.log().fail_create_count = 1.0;
        f.start_ok(None);
        let entry = f.store.open().unwrap();
        let store = f.store.clone();
        let original = entry.clone();
        f.sync.log().on_create = Some(Arc::new(move |_: &TimeEntry| {
            let mut changed = original.clone();
            changed.segments = vec![Segment {
                ended_at: Some(T0 + 3.0 * MIN),
                ..original.segments[0].clone()
            }];
            store.put(&changed);
        }));

        f.flush(25.0).unwrap();

        assert_eq!(f.sync.creates().len(), 1);
        assert_eq!(f.sync.syncs().len(), 0);
        assert_eq!(
            pending_states(&f),
            vec![PendingEntrySyncState::PendingCreate]
        );
    }
}

mod timer_service_discard_away_sleep_lock {
    use super::*;

    fn discard_away(f: &Fixture, start: f64, resume: f64) {
        let svc = f.svc.clone();
        f.run(async move { svc.discard_away(start, resume).await })
            .unwrap();
    }

    #[test]
    fn trims_the_away_gap_and_keeps_the_timer_running() {
        let f = Fixture::new();
        f.start_ok(None); // WORK from T0
        f.clock.advance(5.0 * MIN); // worked 5 min, then machine sleeps
        let away_start = f.clock.t();
        f.clock.advance(30.0 * MIN); // asleep 30 min
        discard_away(&f, away_start, f.clock.t());

        assert!(f.svc.lock().is_running());
        assert_eq!(running(&f.status()).worked_ms, 5.0 * MIN); // sleep not billed
        // resume + a bit more
        f.clock.advance(2.0 * MIN);
        assert_eq!(running(&f.status()).worked_ms, 7.0 * MIN);
    }

    #[test]
    fn is_a_no_op_when_idle() {
        let f = Fixture::new();
        discard_away(&f, T0, T0 + 10.0 * MIN);
        assert!(!f.svc.lock().is_running());
    }

    #[test]
    fn ignores_trivially_short_gaps() {
        let f = Fixture::new();
        f.start_ok(None);
        f.clock.advance(3.0 * MIN);
        let before = f.status();
        discard_away(&f, f.clock.t(), f.clock.t() + 500.0); // <1s
        let after = f.status();
        assert_eq!(after, before);
    }
}

mod timer_service_pause_for_idle_resume_from_idle {
    use super::*;

    #[test]
    fn freezes_at_the_last_healthy_proof_and_records_a_permission_pause() {
        let f = Fixture::new();
        f.start_ok(None);
        f.clock.advance(5.0 * MIN);
        let last_healthy_at = f.clock.t();
        f.clock.advance(2.0 * MIN);

        let paused = running(
            &f.pause_for_permission(f.clock.t() - last_healthy_at)
                .unwrap(),
        );

        assert!(paused.paused);
        assert_eq!(
            paused.pause_reason,
            Some(TimeEntryPauseReason::PermissionRequired)
        );
        assert_eq!(paused.worked_ms, 5.0 * MIN);
        f.clock.advance(10.0 * MIN);
        assert_eq!(running(&f.status()).worked_ms, 5.0 * MIN);
    }

    #[test]
    fn cannot_resume_a_permission_pause_until_the_accrual_guard_is_ready() {
        let f = Fixture::new();
        f.start_ok(None);
        f.clock.advance(MIN);
        f.pause_for_permission(0.0).unwrap();
        f.accrual.block(true);

        assert!(is_blocked(&f.resume().unwrap_err()));
        let s = running(&f.status());
        assert_eq!(
            (s.paused, s.pause_reason),
            (true, Some(TimeEntryPauseReason::PermissionRequired))
        );

        f.accrual.block(false);
        f.resume().unwrap();
        let s = running(&f.status());
        assert_eq!((s.paused, s.pause_reason), (false, None));
    }

    #[test]
    fn freezes_worked_time_on_pause_and_never_counts_the_idle_gap() {
        let f = Fixture::new();
        f.start_ok(None); // WORK from T0
        f.clock.advance(5.0 * MIN); // worked 5 min
        f.pause_for_idle(0.0).unwrap();

        assert!(f.svc.lock().is_paused());
        let s = running(&f.status());
        assert!(s.paused);
        assert_eq!(s.worked_ms, 5.0 * MIN);

        // Time passes while paused: worked time stays frozen.
        f.clock.advance(10.0 * MIN);
        assert_eq!(running(&f.status()).worked_ms, 5.0 * MIN);

        // Continue: resume a fresh WORK segment; idle gap excluded.
        f.resume_from_idle(f.clock.t()).unwrap();
        assert!(!f.svc.lock().is_paused());
        f.clock.advance(3.0 * MIN);
        assert_eq!(running(&f.status()).worked_ms, 8.0 * MIN); // 5 + 3, not the 10 idle
    }

    #[test]
    fn resume_is_idempotent_and_only_opens_a_segment_when_paused() {
        let f = Fixture::new();
        let idle = f.resume().unwrap();
        assert!(is_idle(&idle));
        assert_eq!(f.sync.syncs().len(), 0);

        f.start_ok(None);
        f.clock.advance(2.0 * MIN);
        let already_running = running(&f.resume().unwrap());
        assert_eq!(
            (already_running.worked_ms, already_running.paused),
            (2.0 * MIN, false)
        );
        assert_eq!(f.sync.syncs().len(), 1);

        f.pause_for_idle(0.0).unwrap();
        f.clock.advance(8.0 * MIN);
        let resumed = running(&f.resume().unwrap());
        assert_eq!((resumed.worked_ms, resumed.paused), (2.0 * MIN, false));
        assert_eq!(f.sync.syncs().len(), 3); // start + pause + resume

        f.clock.advance(3.0 * MIN);
        assert_eq!(running(&f.status()).worked_ms, 5.0 * MIN);
    }

    #[test]
    fn clamps_pause_time_to_the_segment_start_whole_segment_idle() {
        let f = Fixture::new();
        f.start_ok(None);
        f.clock.advance(2.0 * MIN);
        f.pause_for_idle(f.clock.t() - (T0 - 10.0 * MIN)).unwrap(); // cut older than the segment
        assert_eq!(running(&f.status()).worked_ms, 0.0); // clamped: zero worked
    }

    #[test]
    fn break_stop_after_pause_finalizes_at_the_frozen_time() {
        let f = Fixture::new();
        f.start_ok(None);
        f.clock.advance(7.0 * MIN);
        f.pause_for_idle(0.0).unwrap();
        f.clock.advance(20.0 * MIN); // away
        f.stop().unwrap();
        assert!(!f.svc.lock().is_running());
        let entry = f.store.all().remove(0);
        assert_eq!(total_worked_ms(&entry, None).unwrap(), 7.0 * MIN); // away time not billed
    }

    #[test]
    fn pause_is_a_no_op_when_idle_or_already_paused() {
        let f = Fixture::new();
        f.pause_for_idle(f.clock.t() - T0).unwrap(); // not running
        assert!(!f.svc.lock().is_running());
        f.start_ok(None);
        f.pause_for_idle(0.0).unwrap();
        let before = f.status();
        f.pause_for_idle(0.0).unwrap(); // already paused
        assert_eq!(f.status(), before);
    }
}

mod timer_service_meeting_segments {
    use super::*;

    fn begin(f: &Fixture, at: f64) {
        let svc = f.svc.clone();
        f.run(async move { svc.begin_meeting(at).await }).unwrap();
    }

    fn end(f: &Fixture, at: f64) {
        let svc = f.svc.clone();
        f.run(async move { svc.end_meeting(at).await }).unwrap();
    }

    #[test]
    fn switches_work_meeting_work_and_counts_both_as_worked() {
        let f = Fixture::new();
        f.start_ok(None); // WORK from T0
        f.clock.advance(5.0 * MIN);
        begin(&f, f.clock.t()); // MEETING from T0+5
        assert!(f.svc.lock().is_in_meeting_segment());
        f.clock.advance(20.0 * MIN);
        end(&f, f.clock.t()); // WORK from T0+25
        assert!(!f.svc.lock().is_in_meeting_segment());
        f.clock.advance(3.0 * MIN);
        assert_eq!(running(&f.status()).worked_ms, 28.0 * MIN); // 5 + 20 + 3, all counted
    }

    #[test]
    fn begin_meeting_is_a_no_op_when_not_running_or_already_in_a_meeting() {
        let f = Fixture::new();
        begin(&f, f.clock.t()); // not running
        assert!(!f.svc.lock().is_running());
        f.start_ok(None);
        begin(&f, f.clock.t());
        let before = f.status();
        begin(&f, f.clock.t()); // already meeting
        assert_eq!(f.status(), before);
    }

    #[test]
    fn end_meeting_is_a_no_op_when_not_in_a_meeting() {
        let f = Fixture::new();
        f.start_ok(None);
        let before = f.status();
        end(&f, f.clock.t());
        assert_eq!(f.status(), before);
    }
}
