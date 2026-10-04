//! 1:1 port of `timerService.test.ts`, part 1: start, status, stop, pause,
//! prepareForQuit, prepareForAway. `describe` is a module, `it` a test with the
//! same name in `snake_case`.
#![allow(
    clippy::float_cmp,
    clippy::float_arithmetic,
    clippy::unwrap_used,
    reason = "the ported tests compare the exact doubles the TypeScript tests compare, with the same arithmetic"
)]

mod timer_support;

use std::sync::{Arc, Mutex};

use futures_util::future::{BoxFuture, FutureExt};
use timer_support::spy_sync::{Overrides, receipt};
use timer_support::{Fixture, Gate, MIN, T0, is_blocked, is_idle, running};
use timo_core::timer::dto::{TimerSyncCorrection, TimerSyncReceipt};
use timo_core::timer::error::SyncError;
use timo_core::timer::traits::SyncClient;
use timo_core::timer::types::{
    PendingEntrySyncState, StartArgs, TimerAwayReason, TimerExitReason, TimerRecoveryReason,
};
use timo_core::types::TimeEntry;
use timo_core::{TimeEntryPauseReason, total_worked_ms};

mod timer_service_start {
    use super::*;

    #[test]
    fn does_not_mutate_local_state_when_permissions_block_a_new_start() {
        let f = Fixture::new();
        f.accrual.block(true);

        let err = f.start(Some("task-a")).unwrap_err();
        assert!(is_blocked(&err));

        assert!(f.store.open().is_none());
        assert_eq!(f.sync.creates().len(), 0);
    }

    #[test]
    fn creates_a_running_entry_and_persists_and_syncs_it() {
        let f = Fixture::new();
        let status = f.start_ok(None);
        assert!(!is_idle(&status));
        assert!(f.svc.lock().is_running());
        assert!(f.store.open().is_some());
        assert_eq!(f.sync.creates().len(), 1);
        assert_eq!(f.sync.syncs().len(), 1);
    }

    #[test]
    fn does_not_publish_a_new_timer_when_the_durable_insert_fails() {
        let f = Fixture::new();
        f.store.inner().fail_next_upsert = true;
        let err = f.start(Some("task-a")).unwrap_err();
        assert_eq!(err.to_string(), "sqlite_write_failed");
        assert!(is_idle(&f.status()));
        assert_eq!(f.store.all().len(), 0);
        assert_eq!(f.sync.calls(), Vec::<String>::new());
    }

    /// A client whose `create` waits until released, and whose `sync` answers at once.
    #[derive(Clone, Default)]
    struct BlockedSync {
        pending: Arc<Mutex<Option<TimeEntry>>>,
        release: Gate,
    }

    impl SyncClient for BlockedSync {
        fn create(
            &self,
            entry: &TimeEntry,
        ) -> BoxFuture<'static, Result<TimerSyncReceipt, SyncError>> {
            *self.pending.lock().unwrap() = Some(entry.clone());
            let gate = self.release.wait();
            let entry = entry.clone();
            async move {
                gate.await;
                Ok(receipt(
                    &entry,
                    Overrides {
                        accepted_revision: Some(0.0),
                        canonical_hash: Some("0".repeat(64)),
                        correction: None,
                    },
                ))
            }
            .boxed()
        }

        fn sync(
            &self,
            entry: &TimeEntry,
        ) -> BoxFuture<'static, Result<TimerSyncReceipt, SyncError>> {
            let result = receipt(entry, Overrides::default());
            async move { Ok(result) }.boxed()
        }
    }

    #[test]
    fn publishes_the_durable_local_timer_without_waiting_for_the_network() {
        let f = Fixture::new();
        let blocked = BlockedSync::default();
        let service = f.runtime_with(blocked.clone(), None);

        let svc = service.clone();
        let status = f
            .run(async move { svc.start(StartArgs::default()).await })
            .unwrap();
        assert!(!is_idle(&status));
        assert!(f.store.open().is_some());

        blocked.release.open();
        let svc = service.clone();
        f.run(async move { svc.flush_unsynced_default().await })
            .unwrap();
        let pending = blocked.pending.lock().unwrap().clone().unwrap();
        assert_eq!(Some(pending.id), f.store.open().map(|e| e.id));
    }

    /// `{ create: receipt(e, { correction: 'CLOCK_CLAMP' }), sync: receipt(e) }`
    struct CorrectingSync;

    impl SyncClient for CorrectingSync {
        fn create(
            &self,
            entry: &TimeEntry,
        ) -> BoxFuture<'static, Result<TimerSyncReceipt, SyncError>> {
            let result = receipt(
                entry,
                Overrides {
                    correction: Some(TimerSyncCorrection::ClockClamp),
                    ..Overrides::default()
                },
            );
            async move { Ok(result) }.boxed()
        }

        fn sync(
            &self,
            entry: &TimeEntry,
        ) -> BoxFuture<'static, Result<TimerSyncReceipt, SyncError>> {
            let result = receipt(entry, Overrides::default());
            async move { Ok(result) }.boxed()
        }
    }

    #[test]
    fn records_a_visible_notice_for_an_acknowledged_server_clock_correction() {
        let f = Fixture::new();
        let correcting = f.runtime_with(CorrectingSync, None);

        let svc = correcting.clone();
        f.run(async move { svc.start(StartArgs::default()).await })
            .unwrap();
        let svc = correcting.clone();
        f.run(async move { svc.flush_unsynced_default().await })
            .unwrap();

        let notice = correcting.lock().recovery_notice().unwrap().unwrap();
        assert_eq!(notice.reason, TimerRecoveryReason::ServerClockCorrected);
    }

    #[test]
    fn switches_to_another_task_without_requiring_a_stop_first() {
        let f = Fixture::new();
        f.start_ok(Some("task-a"));
        f.clock.advance(10.0 * MIN);

        let status = f.start_ok(Some("task-b"));

        let s = running(&status);
        assert_eq!(s.guid.as_deref(), Some("task-b"));
        let entries = f.store.all();
        assert_eq!(entries.len(), 2);
        let old = entries
            .iter()
            .find(|e| e.lark_task_guid == Some(Some("task-a".into())))
            .unwrap();
        let new = entries
            .iter()
            .find(|e| e.lark_task_guid == Some(Some("task-b".into())))
            .unwrap();
        assert_eq!(old.ended_at, Some(T0 + 10.0 * MIN));
        assert_eq!(total_worked_ms(old, None).unwrap(), 10.0 * MIN);
        assert_eq!(new.ended_at, None);
        assert_eq!(new.started_at, T0 + 10.0 * MIN);
        assert_eq!(
            f.store.open().unwrap().lark_task_guid,
            Some(Some("task-b".into()))
        );
        assert_eq!(f.sync.creates(), vec![old.id.clone(), new.id.clone()]);
        assert_eq!(
            f.sync.syncs(),
            vec![old.id.clone(), old.id.clone(), new.id.clone()]
        );
    }

    #[test]
    fn keeps_the_old_task_running_when_the_task_switch_close_cannot_persist() {
        let f = Fixture::new();
        f.start_ok(Some("task-a"));
        f.clock.advance(MIN);
        f.store.inner().fail_next_upsert = true;

        let err = f.start(Some("task-b")).unwrap_err();
        assert_eq!(err.to_string(), "sqlite_write_failed");
        let s = running(&f.status());
        assert_eq!((s.guid.as_deref(), s.paused), (Some("task-a"), false));
        assert_eq!(
            f.store.open().unwrap().lark_task_guid,
            Some(Some("task-a".into()))
        );
    }

    #[test]
    fn checks_permissions_before_a_task_switch_can_close_the_current_entry() {
        let f = Fixture::new();
        f.start_ok(Some("task-a"));
        f.accrual.block(true);

        assert!(is_blocked(&f.start(Some("task-b")).unwrap_err()));

        let s = running(&f.status());
        assert_eq!((s.guid.as_deref(), s.paused), (Some("task-a"), false));
        assert_eq!(f.sync.creates().len(), 1);
    }

    #[test]
    fn is_a_no_op_when_starting_the_task_that_is_already_running() {
        let f = Fixture::new();
        let first = f.start_ok(Some("task-a"));
        f.clock.advance(3.0 * MIN);
        let second = f.start_ok(Some("task-a"));

        assert!(!is_idle(&first));
        let s = running(&second);
        assert_eq!(
            (s.guid.as_deref(), s.worked_ms),
            (Some("task-a"), 3.0 * MIN)
        );
        assert_eq!(f.store.all().len(), 1);
        assert_eq!(f.sync.creates().len(), 1);
        assert_eq!(f.sync.syncs().len(), 1);
    }

    #[test]
    fn attributes_a_lark_task_guid_and_persists_it() {
        let f = Fixture::new();
        let status = f.start_ok(Some("guid-123"));
        assert_eq!(running(&status).guid.as_deref(), Some("guid-123"));
        assert_eq!(
            f.store.open().unwrap().lark_task_guid,
            Some(Some("guid-123".into()))
        );
    }

    #[test]
    fn defaults_lark_task_guid_to_null_when_not_provided() {
        let f = Fixture::new();
        let status = f.start_ok(None);
        assert_eq!(running(&status).guid, None);
    }
}

mod timer_service_status_worked_time {
    use super::*;

    #[test]
    fn accrues_worked_ms_as_the_clock_advances() {
        let f = Fixture::new();
        f.start_ok(None);
        f.clock.advance(7.0 * MIN);
        assert_eq!(running(&f.status()).worked_ms, 7.0 * MIN);
    }

    #[test]
    fn keeps_today_worked_ms_cumulative_across_stop_start_cycles() {
        let f = Fixture::new();
        f.start_ok(None);
        f.clock.advance(10.0 * MIN);
        let stopped = f.stop().unwrap();
        assert!(is_idle(&stopped));
        assert_eq!(stopped.worked_ms(), 10.0 * MIN);

        f.clock.advance(5.0 * MIN);
        f.start_ok(None);
        assert_eq!(running(&f.status()).worked_ms, 10.0 * MIN);

        f.clock.advance(2.0 * MIN);
        assert_eq!(running(&f.status()).worked_ms, 12.0 * MIN);
    }
}

mod timer_service_stop {
    use super::*;

    #[test]
    fn closes_the_entry_and_returns_to_idle() {
        let f = Fixture::new();
        f.start_ok(None);
        f.clock.advance(10.0 * MIN);
        let status = f.stop().unwrap();
        assert!(is_idle(&status));
        assert!(!f.svc.lock().is_running());
        assert!(f.store.open().is_none());
        let closed = f.store.all().remove(0);
        assert_eq!(total_worked_ms(&closed, None).unwrap(), 10.0 * MIN);
        assert_eq!(f.sync.syncs(), vec![closed.id.clone(), closed.id]);
    }

    #[test]
    fn is_a_no_op_when_not_running() {
        let f = Fixture::new();
        let status = f.stop().unwrap();
        assert!(is_idle(&status));
        assert_eq!(f.sync.syncs().len(), 0);
    }

    #[test]
    fn stays_visibly_running_when_the_durable_close_fails() {
        let f = Fixture::new();
        f.start_ok(None);
        f.store.inner().fail_next_upsert = true;
        assert_eq!(f.stop().unwrap_err().to_string(), "sqlite_write_failed");
        assert!(!running(&f.status()).paused);
        assert!(f.store.open().is_some());
    }
}

mod timer_service_pause {
    use super::*;

    #[test]
    fn freezes_work_but_keeps_the_same_entry_available_for_explicit_resume() {
        let f = Fixture::new();
        let started = f.start_ok(Some("task-a"));
        f.clock.advance(5.0 * MIN);

        let paused = running(&f.pause().unwrap());

        assert_eq!(paused.entry_id, running(&started).entry_id);
        assert_eq!(paused.guid.as_deref(), Some("task-a"));
        assert!(paused.paused);
        assert_eq!(paused.pause_reason, Some(TimeEntryPauseReason::Manual));
        assert_eq!(paused.worked_ms, 5.0 * MIN);
        f.clock.advance(10.0 * MIN);
        let s = running(&f.status());
        assert!(s.paused);
        assert_eq!(s.worked_ms, 5.0 * MIN);

        f.resume().unwrap();
        f.clock.advance(2.0 * MIN);
        let s = running(&f.status());
        assert!(!s.paused);
        assert_eq!(s.worked_ms, 7.0 * MIN);
    }

    #[test]
    fn is_idempotent_while_idle_or_already_paused() {
        let f = Fixture::new();
        assert!(is_idle(&f.pause().unwrap()));
        f.start_ok(None);
        f.pause().unwrap();
        let once = f.status();

        assert_eq!(f.pause().unwrap(), once);
    }

    #[test]
    fn does_not_publish_a_pause_when_sqlite_rejects_it() {
        let f = Fixture::new();
        f.start_ok(None);
        f.store.inner().fail_next_upsert = true;
        assert_eq!(f.pause().unwrap_err().to_string(), "sqlite_write_failed");
        assert!(!running(&f.status()).paused);
    }
}

mod timer_service_prepare_for_quit {
    use super::*;

    #[test]
    fn stops_an_active_timer_locally_and_clears_the_exit_intent_after_persistence() {
        let f = Fixture::new();
        f.start_ok(None);
        f.clock.advance(9.0 * MIN);

        let status = f.prepare_for_quit(TimerExitReason::Quit).unwrap();

        assert!(is_idle(&status));
        assert!(f.store.open().is_none());
        assert!(f.store.inner().exit_intent.is_none());
        let closed = f.store.all().remove(0);
        assert_eq!(closed.ended_at, Some(T0 + 9.0 * MIN));
        assert_eq!(total_worked_ms(&closed, None).unwrap(), 9.0 * MIN);
    }

    #[test]
    fn quits_while_paused_without_adding_the_paused_gap_as_worked_time() {
        let f = Fixture::new();
        f.start_ok(None);
        f.clock.advance(5.0 * MIN);
        f.pause_for_idle(0.0).unwrap();
        f.clock.advance(20.0 * MIN);

        f.prepare_for_quit(TimerExitReason::Quit).unwrap();

        let closed = f.store.all().remove(0);
        assert_eq!(closed.ended_at, Some(T0 + 25.0 * MIN));
        assert_eq!(total_worked_ms(&closed, None).unwrap(), 5.0 * MIN);
    }

    #[test]
    fn leaves_the_closed_row_pending_when_quit_sync_fails() {
        let f = Fixture::new();
        f.start_ok(None);
        f.sync.log().fail_sync_count = 1.0;
        f.clock.advance(6.0 * MIN);

        f.prepare_for_quit(TimerExitReason::Quit).unwrap();

        let closed = f.store.all().remove(0);
        assert_eq!(closed.ended_at, Some(T0 + 6.0 * MIN));
        let unsynced = f.store.unsynced();
        assert_eq!(unsynced.len(), 1);
        assert_eq!(unsynced[0].sync_state, PendingEntrySyncState::PendingUpdate);
        assert!(f.store.inner().exit_intent.is_none());
    }

    #[test]
    fn clears_stale_exit_intent_when_nothing_is_running() {
        let f = Fixture::new();
        f.store.inner().exit_intent = Some(timo_core::timer::types::TimerExitIntent {
            reason: TimerExitReason::Quit,
            entry_id: "old".into(),
            observed_at: f.clock.t(),
        });

        f.prepare_for_quit(TimerExitReason::Quit).unwrap();

        assert!(f.store.inner().exit_intent.is_none());
    }
}

mod timer_service_prepare_for_away {
    use super::*;

    #[test]
    fn stops_a_running_timer_at_sleep_start_and_records_a_sleep_notice() {
        let f = Fixture::new();
        f.start_ok(None);
        f.clock.advance(5.0 * MIN);

        let status = f.prepare_for_away(TimerAwayReason::Suspend, 0.0).unwrap();

        assert!(is_idle(&status));
        assert!(f.store.open().is_none());
        assert!(f.store.inner().away.is_none());
        let closed = f.store.all().remove(0);
        assert_eq!(closed.ended_at, Some(T0 + 5.0 * MIN));
        assert_eq!(total_worked_ms(&closed, None).unwrap(), 5.0 * MIN);
        let notice = f.store.inner().recovery.clone().unwrap();
        assert_eq!(notice.entry_id, closed.id);
        assert_eq!(notice.recovered_at, T0 + 5.0 * MIN);
        assert_eq!(notice.reason, TimerRecoveryReason::SleepStop);
    }

    #[test]
    fn stops_a_paused_timer_without_counting_the_away_gap() {
        let f = Fixture::new();
        f.start_ok(None);
        f.clock.advance(5.0 * MIN);
        f.pause_for_idle(0.0).unwrap();
        f.clock.advance(20.0 * MIN);

        f.prepare_for_away(TimerAwayReason::Lock, 0.0).unwrap();

        let closed = f.store.all().remove(0);
        assert_eq!(closed.ended_at, Some(T0 + 25.0 * MIN));
        assert_eq!(total_worked_ms(&closed, None).unwrap(), 5.0 * MIN);
        let notice = f.store.inner().recovery.clone().unwrap();
        assert_eq!(
            (notice.entry_id, notice.recovered_at, notice.reason),
            (closed.id, T0 + 25.0 * MIN, TimerRecoveryReason::LockStop)
        );
    }

    #[test]
    fn leaves_the_closed_row_pending_when_sleep_stop_sync_fails() {
        let f = Fixture::new();
        f.start_ok(None);
        f.sync.log().fail_sync_count = 1.0;
        f.clock.advance(6.0 * MIN);

        f.prepare_for_away(TimerAwayReason::Suspend, 0.0).unwrap();

        let closed = f.store.all().remove(0);
        assert_eq!(closed.ended_at, Some(T0 + 6.0 * MIN));
        let unsynced = f.store.unsynced();
        assert_eq!(unsynced.len(), 1);
        assert_eq!(unsynced[0].sync_state, PendingEntrySyncState::PendingUpdate);
        assert!(f.store.inner().away.is_none());
    }

    #[test]
    fn keeps_the_timer_recoverable_when_the_durable_away_write_fails() {
        let f = Fixture::new();
        f.start_ok(Some("task-1"));
        f.clock.advance(4.0 * MIN);
        f.store.inner().fail_upsert_with = Some("disk unavailable".into());

        let err = f.prepare_for_away(TimerAwayReason::Lock, 0.0).unwrap_err();
        assert_eq!(err.to_string(), "disk unavailable");
        let s = running(&f.status());
        assert_eq!(s.guid.as_deref(), Some("task-1"));
        let away = f.store.inner().away.clone().unwrap();
        assert_eq!(
            (away.reason, away.away_started_at),
            (TimerAwayReason::Lock, T0 + 4.0 * MIN)
        );

        f.store.inner().fail_upsert_with = None;
        f.prepare_for_away(TimerAwayReason::Lock, f.clock.t() - (T0 + 4.0 * MIN))
            .unwrap();
        assert!(is_idle(&f.status()));
        assert!(f.store.inner().away.is_none());
    }

    #[test]
    fn is_a_no_op_when_away_fires_while_idle() {
        let f = Fixture::new();
        f.store.inner().away = Some(timo_core::timer::types::TimerAwayState {
            reason: TimerAwayReason::Suspend,
            entry_id: "old".into(),
            away_started_at: f.clock.t(),
            observed_at: f.clock.t(),
        });

        let status = f.prepare_for_away(TimerAwayReason::Suspend, 0.0).unwrap();

        assert!(is_idle(&status));
        assert!(f.store.inner().away.is_none());
        assert!(f.store.inner().recovery.is_none());
    }
}
