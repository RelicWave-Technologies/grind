//! 1:1 port of `timerService.test.ts`, part 3: crash recovery, liveness, server
//! finalization and the workspace business day.
#![allow(
    clippy::float_cmp,
    clippy::float_arithmetic,
    clippy::unwrap_used,
    reason = "the ported tests compare the exact doubles the TypeScript tests compare, with the same arithmetic"
)]

mod timer_support;

use timer_support::{FakeClock, Fixture, MIN, SpySync, T0, is_idle, running};
use timo_core::js::date::{DateParse, parse};
use timo_core::js::math::{div, mul};
use timo_core::js::number::{add, floor, sub};
use timo_core::timer::executor::ManualExecutor;
use timo_core::timer::hash::{canonical_entry_hash, canonical_entry_payload};
use timo_core::timer::traits::{BusinessDayProvider, ServerLedgerCache};
use timo_core::timer::types::{
    DayWindow, PendingEntrySyncState, StartArgs, TimerAwayReason, TimerAwayState, TimerOwner,
    TimerRecoveryReason, TodayLedgerMode,
};
use timo_core::timer::{TimerRuntime, TimerService};
use timo_core::today_ledger::ServerLedgerEntry;
use timo_core::types::{AgentCloseReason, Segment, SegmentKind, TimeEntry, TimeEntrySource};
use timo_core::{close_time_entry, total_worked_ms};

mod timer_service_recover_crash_recovery {
    use super::*;

    #[test]
    fn recovers_durable_sleep_state_before_generic_crash_recovery() {
        let f = Fixture::new();
        f.start_ok(None);
        f.clock.advance(8.0 * MIN);
        let open = f.store.open().unwrap();
        f.store.inner().away = Some(TimerAwayState {
            reason: TimerAwayReason::Suspend,
            entry_id: open.id.clone(),
            away_started_at: f.clock.t(),
            observed_at: f.clock.t(),
        });
        f.clock.advance(60.0 * MIN);

        let rebooted = f.reboot();
        let result = rebooted.lock().recover_away().unwrap().unwrap();

        assert_eq!(
            (result.entry_id.as_str(), result.recovered_at),
            (open.id.as_str(), T0 + 8.0 * MIN)
        );
        assert!(f.store.inner().away.is_none());
        let recovered = f.store.all().remove(0);
        assert_eq!(recovered.ended_at, Some(T0 + 8.0 * MIN));
        assert_eq!(total_worked_ms(&recovered, None).unwrap(), 8.0 * MIN);
        let notice = f.store.inner().recovery.clone().unwrap();
        assert_eq!(
            (notice.entry_id.as_str(), notice.recovered_at, notice.reason),
            (
                open.id.as_str(),
                T0 + 8.0 * MIN,
                TimerRecoveryReason::SleepStop
            )
        );
    }

    #[test]
    fn clears_stale_away_state_for_an_already_closed_entry_and_creates_a_lock_notice() {
        let f = Fixture::new();
        f.start_ok(None);
        f.clock.advance(4.0 * MIN);
        let open = f.store.open().unwrap();
        f.store.put(&close_time_entry(&open, f.clock.t()).unwrap());
        f.store.inner().away = Some(TimerAwayState {
            reason: TimerAwayReason::Lock,
            entry_id: open.id.clone(),
            away_started_at: f.clock.t(),
            observed_at: f.clock.t(),
        });

        let rebooted = f.reboot();
        let result = rebooted.lock().recover_away().unwrap().unwrap();

        assert_eq!(
            (result.entry_id.as_str(), result.recovered_at),
            (open.id.as_str(), T0 + 4.0 * MIN)
        );
        assert!(f.store.inner().away.is_none());
        assert!(f.store.open().is_none());
        let notice = f.store.inner().recovery.clone().unwrap();
        assert_eq!(
            (notice.entry_id.as_str(), notice.recovered_at, notice.reason),
            (
                open.id.as_str(),
                T0 + 4.0 * MIN,
                TimerRecoveryReason::LockStop
            )
        );
    }

    #[test]
    fn closes_a_left_open_entry_at_last_known_active_and_records_a_recovery_notice() {
        // Simulate a crash: persist an open entry, then build a fresh service.
        let f = Fixture::new();
        f.start_ok(None);
        let last_active = f.clock.t() + 3.0 * MIN;

        let svc2 = f.reboot();
        let result = svc2.lock().recover(last_active).unwrap().unwrap();

        assert_eq!(result.recovered_at, last_active);
        assert!(!svc2.lock().is_running());
        assert!(f.store.open().is_none());
        let recovered = f.store.all().remove(0);
        assert_eq!(recovered.ended_at, Some(last_active));
        assert_eq!(total_worked_ms(&recovered, None).unwrap(), 3.0 * MIN);
        let notice = f.store.inner().recovery.clone().unwrap();
        assert_eq!(
            (notice.entry_id, notice.recovered_at, notice.reason),
            (
                recovered.id,
                last_active,
                TimerRecoveryReason::UnexpectedShutdown
            )
        );
    }

    #[test]
    fn does_nothing_when_there_is_no_open_entry() {
        let f = Fixture::new();
        assert!(f.svc.lock().recover(f.clock.t()).unwrap().is_none());
        assert!(!f.svc.lock().is_running());
    }

    #[test]
    fn never_recovers_a_paused_entry_before_its_latest_segment_end() {
        let f = Fixture::new();
        f.start_ok(None);
        f.clock.advance(10.0 * MIN);
        f.pause_for_idle(0.0).unwrap();
        let stale_liveness = T0 + 5.0 * MIN;

        let rebooted = f.reboot();
        let result = rebooted.lock().recover(stale_liveness).unwrap();

        assert_eq!(result.map(|r| r.recovered_at), Some(T0 + 10.0 * MIN));
        let recovered = f.store.all().remove(0);
        assert_eq!(recovered.ended_at, Some(T0 + 10.0 * MIN));
        assert_eq!(total_worked_ms(&recovered, None).unwrap(), 10.0 * MIN);
    }

    #[test]
    fn dismisses_recovery_notices() {
        let f = Fixture::new();
        f.start_ok(None);
        f.svc.lock().recover(f.clock.t()).unwrap();

        assert!(f.svc.lock().recovery_notice().unwrap().is_some());
        f.svc.lock().dismiss_recovery_notice().unwrap();
        assert!(f.svc.lock().recovery_notice().unwrap().is_none());
    }
}

mod timer_service_liveness_crash_recovery_bound {
    use super::*;

    #[test]
    fn heartbeat_persists_the_current_time_while_an_entry_is_open() {
        let f = Fixture::new();
        f.start_ok(None);
        f.clock.advance(42.0 * 1000.0);
        f.svc.lock().heartbeat().unwrap();
        assert_eq!(f.store.inner().liveness, Some(f.clock.t()));
        assert_eq!(f.svc.lock().last_liveness().unwrap(), Some(f.clock.t()));
    }

    #[test]
    fn heartbeat_is_a_no_op_when_nothing_is_open() {
        let f = Fixture::new();
        f.svc.lock().heartbeat().unwrap();
        assert_eq!(f.store.inner().liveness, None);
    }

    #[test]
    fn boot_recovery_closes_a_dangling_entry_at_the_last_liveness_tick_not_now() {
        // Work 5 min, last heartbeat at +5min, then the machine hard-dies and the
        // app reboots an hour later. The dead hour must NOT be credited.
        let f = Fixture::new();
        f.start_ok(None);
        f.clock.advance(5.0 * MIN);
        f.svc.lock().heartbeat().unwrap();
        let last_alive = f.clock.t();
        f.clock.advance(60.0 * MIN); // an hour of being powered off

        let rebooted = f.reboot();
        let at = rebooted
            .lock()
            .last_liveness()
            .unwrap()
            .unwrap_or(f.clock.t());
        rebooted.lock().recover(at).unwrap();

        let recovered = f.store.all().remove(0);
        assert_eq!(recovered.ended_at, Some(last_alive));
        assert_eq!(total_worked_ms(&recovered, None).unwrap(), 5.0 * MIN); // the dead hour is gone
    }

    #[test]
    fn falls_back_to_now_when_liveness_was_never_written() {
        let f = Fixture::new();
        f.start_ok(None);
        f.clock.advance(3.0 * MIN);
        // No heartbeat ever fired: lastLiveness null, so the caller uses now().
        let rebooted = f.reboot();
        assert_eq!(rebooted.lock().last_liveness().unwrap(), None);
        let at = rebooted
            .lock()
            .last_liveness()
            .unwrap()
            .unwrap_or(f.clock.t());
        rebooted.lock().recover(at).unwrap();
        let recovered = f.store.all().remove(0);
        assert_eq!(recovered.ended_at, Some(f.clock.t()));
    }
}

mod timer_service_server_finalization {
    use super::*;

    #[test]
    fn stops_the_matching_local_timer_preserves_its_journal_evidence_and_records_a_visible_notice()
    {
        let f = Fixture::new();
        let running_status = f.start_ok(Some("task"));
        let entry_id = running(&running_status).entry_id;

        f.clock.advance(2.0 * MIN);
        let status = f
            .svc
            .accept_server_finalization(&entry_id, f.clock.t())
            .unwrap();

        assert!(is_idle(&status));
        assert!(f.store.open().is_none());
        let unsynced = f.store.unsynced();
        assert_eq!(unsynced.len(), 1);
        assert_eq!(unsynced[0].sync_state, PendingEntrySyncState::PendingUpdate);
        let notice = f.svc.lock().recovery_notice().unwrap().unwrap();
        assert_eq!(
            (notice.entry_id.clone(), notice.reason, notice.recovered_at),
            (entry_id, TimerRecoveryReason::ServerFinalized, f.clock.t())
        );
    }
}

/// `{ window(now) { ... } }` for a fixed UTC offset (Asia/Kolkata has no DST),
/// standing in for `dateKeyInTimeZone` + `localDayWindowInTimeZone`.
struct OffsetDay(f64);

impl BusinessDayProvider for OffsetDay {
    fn window(&self, now: f64) -> Option<DayWindow> {
        const DAY: f64 = 86_400_000.0;
        let start = sub(mul(floor(div(add(now, self.0), DAY)), DAY), self.0);
        Some(DayWindow {
            start,
            end: add(start, DAY),
        })
    }
}

struct FixedWindow(DayWindow);

impl BusinessDayProvider for FixedWindow {
    fn window(&self, _: f64) -> Option<DayWindow> {
        Some(self.0)
    }
}

struct FixedCache(Vec<ServerLedgerEntry>);

impl ServerLedgerCache for FixedCache {
    fn list(
        &self,
        _: &TimerOwner,
        _: DayWindow,
        _: f64,
    ) -> Result<Vec<ServerLedgerEntry>, timo_core::timer::TimerError> {
        Ok(self.0.clone())
    }
}

fn runtime(
    clock: &FakeClock,
    configure: impl FnOnce(TimerService) -> TimerService + 'static,
) -> (std::sync::Arc<TimerRuntime>, ManualExecutor) {
    let fixture = Fixture::with_clock(clock.clone());
    let svc = fixture.runtime_with(SpySync::new(), Some(Box::new(configure)));
    (svc, fixture.exec)
}

/// `approvedManual` of the second business-day test.
fn approved_manual_entry() -> TimeEntry {
    TimeEntry {
        id: "manual-entry".into(),
        client_uuid: "manual-client".into(),
        user_id: "test-user".into(),
        lark_task_guid: Some(Some("manual-task".into())),
        source: TimeEntrySource::Manual,
        revision: 0.0,
        started_at: T0 + 30.0 * MIN,
        ended_at: Some(T0 + 60.0 * MIN),
        pause_reason: None,
        close_reason: Some(AgentCloseReason::Agent),
        segments: vec![Segment {
            id: "manual-segment".into(),
            kind: SegmentKind::Work,
            started_at: T0 + 30.0 * MIN,
            ended_at: Some(T0 + 60.0 * MIN),
        }],
        shape: timo_core::types::EntryShape::default(),
    }
}

mod timer_service_workspace_business_day {
    use super::*;

    #[test]
    fn counts_only_the_portion_after_asia_kolkata_midnight_when_the_laptop_zone_differs() {
        let DateParse::Time(start) = parse("2026-07-14T18:25:00.000Z") else {
            panic!("date")
        };
        let clock = FakeClock::new(start);
        let (service, exec) = runtime(&clock, |s| {
            s.with_business_day(Box::new(OffsetDay(19_800_000.0)))
        });

        let svc = service.clone();
        timer_support::run_on(&exec, async move {
            svc.start(StartArgs {
                lark_task_guid: Some("overnight".into()),
            })
            .await
        })
        .unwrap();
        clock.advance(10.0 * MIN);

        let s = running(&service.status().unwrap());
        assert_eq!(s.worked_ms, 5.0 * MIN);
        assert_eq!(service.lock().list_today(clock.t()).unwrap().len(), 1);
        let by_task = service.lock().worked_ms_by_task(Some(clock.t())).unwrap();
        assert_eq!(
            by_task
                .iter()
                .find(|(g, _)| g == "overnight")
                .map(|(_, ms)| *ms),
            Some(5.0 * MIN)
        );
    }

    #[test]
    fn uses_the_same_approved_manual_projection_for_every_today_surface() {
        let clock = FakeClock::new(T0 + 2.0 * 60.0 * MIN);
        let approved_manual = approved_manual_entry();
        let canonical_payload = canonical_entry_payload(&approved_manual).unwrap();
        let canonical_hash = canonical_entry_hash(&approved_manual).unwrap();
        let cached = ServerLedgerEntry {
            entry: approved_manual,
            canonical_payload,
            canonical_hash,
        };
        let window = DayWindow {
            start: T0,
            end: T0 + 24.0 * 60.0 * MIN,
        };
        let (service, _exec) = runtime(&clock, move |s| {
            s.with_business_day(Box::new(FixedWindow(window)))
                .with_server_cache(Box::new(FixedCache(vec![cached])))
        });
        service.set_today_ledger_mode(TodayLedgerMode::Visible);

        let status = service.status().unwrap();
        assert!(is_idle(&status));
        assert_eq!(status.worked_ms(), 30.0 * MIN);
        let today = service.lock().list_today(clock.t()).unwrap();
        assert_eq!(
            (today.len(), today[0].id.as_str(), today[0].source),
            (1, "manual-entry", TimeEntrySource::Manual)
        );
        let by_task = service.lock().worked_ms_by_task(Some(clock.t())).unwrap();
        assert_eq!(
            by_task
                .iter()
                .find(|(g, _)| g == "manual-task")
                .map(|(_, ms)| *ms),
            Some(30.0 * MIN)
        );
    }
}
