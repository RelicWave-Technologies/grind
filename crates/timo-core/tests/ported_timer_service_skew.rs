//! 1:1 port of `timerService.test.ts`, part 4: the device/server clock-frame
//! split, "a skewed device clock can never over-credit" and the ledger memo.
#![allow(
    clippy::float_cmp,
    clippy::float_arithmetic,
    clippy::unwrap_used,
    reason = "the ported tests compare the exact doubles the TypeScript tests compare, with the same arithmetic"
)]

mod timer_support;

use timer_support::{Fixture, MIN, running};
use timo_core::timer::types::TimerAwayReason;
use timo_core::{clamp_entry_to_server_clock, total_worked_ms, validate_entry};

/// `expect(a).toBeCloseTo(b, -3)`.
fn close_to(received: f64, expected: f64, digits: i32) {
    let tolerance = 10_f64.powi(-digits) / 2.0;
    assert!(
        (expected - received).abs() < tolerance,
        "{received} is not within {tolerance} of {expected}"
    );
}

/// Device clock five minutes BEHIND the server clock the timer is aligned to.
const SKEW: f64 = 5.0 * MIN;

mod timer_service_device_server_clock_skew {
    use super::*;

    fn device_now(f: &Fixture) -> f64 {
        f.clock.t() - SKEW
    }

    #[test]
    fn survives_an_idle_pause_measured_on_a_device_clock_that_is_behind() {
        let f = Fixture::new();
        f.start_ok(Some("task-a"));
        f.clock.advance(10.0 * MIN);

        // Exactly what index.ts does: both readings come from the device clock, so
        // the gap between them is meaningful even though neither instant is.
        let idle_seconds = 300.0;
        let idle_started_at = device_now(&f) - idle_seconds * 1000.0;
        f.pause_for_idle((device_now(&f) - idle_started_at).max(0.0))
            .unwrap();
        f.stop().unwrap();

        let entry = f.store.all().remove(0);
        assert_eq!(validate_entry(&entry), Vec::<String>::new());

        // The failure this guards: a boundary from the wrong frame collapsed the
        // segment to zero length, the clamp dropped it, and the server answered
        // 400 invalid_segments on every retry, forever.
        let clamped = clamp_entry_to_server_clock(&entry, f.clock.t(), None);
        assert_eq!(clamped.entry.segments.len(), entry.segments.len());
        assert_eq!(validate_entry(&clamped.entry), Vec::<String>::new());
    }

    #[test]
    fn credits_the_full_worked_time_rather_than_losing_the_skew() {
        let f = Fixture::new();
        f.start_ok(Some("task-a"));
        f.clock.advance(10.0 * MIN);

        // Just went idle: zero elapsed.
        f.pause_for_idle(0.0).unwrap();

        close_to(
            total_worked_ms(&f.store.open().unwrap(), Some(f.clock.t())).unwrap(),
            10.0 * MIN,
            -3,
        );
    }

    #[test]
    fn cuts_an_idle_pause_back_by_the_elapsed_time_no_further() {
        let f = Fixture::new();
        f.start_ok(Some("task-a"));
        f.clock.advance(10.0 * MIN);

        f.pause_for_idle(4.0 * MIN).unwrap();

        close_to(
            total_worked_ms(&f.store.open().unwrap(), Some(f.clock.t())).unwrap(),
            6.0 * MIN,
            -3,
        );
    }

    #[test]
    fn never_cuts_further_back_than_the_segment_start() {
        let f = Fixture::new();
        f.start_ok(Some("task-a"));
        f.clock.advance(2.0 * MIN);

        // An absurd elapsed value must not invent negative time.
        f.pause_for_idle(60.0 * MIN).unwrap();

        assert_eq!(
            total_worked_ms(&f.store.open().unwrap(), Some(f.clock.t())).unwrap(),
            0.0
        );
        assert_eq!(
            validate_entry(&f.store.open().unwrap()),
            Vec::<String>::new()
        );
    }

    #[test]
    fn survives_a_machine_away_boundary_measured_on_the_device_clock() {
        let f = Fixture::new();
        f.start_ok(Some("task-a"));
        f.clock.advance(10.0 * MIN);

        // What power.ts does: the away began at a device reading, and the retry
        // path converts it to elapsed time.
        let away_started_at = device_now(&f);
        f.prepare_for_away(
            TimerAwayReason::Suspend,
            (device_now(&f) - away_started_at).max(0.0),
        )
        .unwrap();

        let entry = f.store.all().remove(0);
        assert_eq!(validate_entry(&entry), Vec::<String>::new());
        assert_eq!(
            clamp_entry_to_server_clock(&entry, f.clock.t(), None)
                .entry
                .segments
                .len(),
            entry.segments.len()
        );
        close_to(
            total_worked_ms(&entry, Some(f.clock.t())).unwrap(),
            10.0 * MIN,
            -3,
        );
    }

    #[test]
    fn survives_a_permission_pause_measured_on_the_device_clock() {
        let f = Fixture::new();
        f.start_ok(Some("task-a"));
        f.clock.advance(10.0 * MIN);

        // What trackingPermissionMonitor does: last-healthy and now are both device
        // readings, six seconds apart.
        let last_healthy_at = device_now(&f) - 6_000.0;
        f.pause_for_permission((device_now(&f) - last_healthy_at).max(0.0))
            .unwrap();

        let entry = f.store.open().unwrap();
        assert_eq!(validate_entry(&entry), Vec::<String>::new());
        close_to(
            total_worked_ms(&entry, Some(f.clock.t())).unwrap(),
            10.0 * MIN - 6_000.0,
            -3,
        );
    }
}

/// The direction of error matters more than its size: whatever the device clock
/// is doing, a boundary must never credit MORE than the real elapsed time.
macro_rules! never_over_credit {
    ($module:ident, $skew:expr, $label:literal) => {
        mod $module {
            use super::*;

            fn device_now(f: &Fixture) -> f64 {
                f.clock.t() - $skew
            }

            #[test]
            fn never_credits_more_than_the_real_elapsed_time_when_the_device_is() {
                let f = Fixture::new();
                f.start_ok(Some("task-a"));
                f.clock.advance(10.0 * MIN);

                // Exactly the caller arithmetic: two device readings, 300s apart.
                let idle_started_at = device_now(&f) - 300_000.0;
                f.pause_for_idle((device_now(&f) - idle_started_at).max(0.0))
                    .unwrap();

                let worked = total_worked_ms(&f.store.open().unwrap(), Some(f.clock.t())).unwrap();
                assert!(worked <= 10.0 * MIN, "{} {worked}", $label);
                close_to(worked, 10.0 * MIN - 300_000.0, -3);
                assert_eq!(
                    validate_entry(&f.store.open().unwrap()),
                    Vec::<String>::new()
                );
            }

            #[test]
            fn closes_an_away_boundary_without_inventing_time_when_the_device_is() {
                let f = Fixture::new();
                f.start_ok(Some("task-a"));
                f.clock.advance(10.0 * MIN);

                let away_started_at = device_now(&f);
                f.prepare_for_away(
                    TimerAwayReason::Suspend,
                    (device_now(&f) - away_started_at).max(0.0),
                )
                .unwrap();

                let entry = f.store.all().remove(0);
                assert!(total_worked_ms(&entry, Some(f.clock.t())).unwrap() <= 10.0 * MIN);
                assert!(entry.ended_at.unwrap() <= f.clock.t());
                assert_eq!(validate_entry(&entry), Vec::<String>::new());
            }

            #[test]
            fn never_ends_an_entry_in_the_future_when_the_device_is() {
                let f = Fixture::new();
                f.start_ok(Some("task-a"));
                f.clock.advance(10.0 * MIN);
                f.pause_for_permission((device_now(&f) - (device_now(&f) - 6_000.0)).max(0.0))
                    .unwrap();
                let stopped = f
                    .store
                    .all()
                    .into_iter()
                    .next()
                    .unwrap_or_else(|| f.store.open().unwrap());

                for seg in &stopped.segments {
                    assert!(seg.started_at <= f.clock.t());
                    if let Some(end) = seg.ended_at {
                        assert!(end <= f.clock.t());
                    }
                }
            }
        }
    };
}

mod timer_service_a_skewed_device_clock_can_never_over_credit {
    use super::*;

    never_over_credit!(ahead, -5.0 * MIN, "ahead");
    never_over_credit!(in_sync, 0.0, "in sync");
    never_over_credit!(behind, 5.0 * MIN, "behind");
}

/// The ledger memo must never change a number, only how often it is read.
mod timer_service_ledger_memo_must_not_change_worked_time {
    use super::*;

    #[test]
    fn accrues_exactly_with_the_clock_while_the_memo_is_warm() {
        let f = Fixture::new();
        f.start_ok(Some("task-a"));

        // Every one of these lands inside the memo TTL with no mutation between.
        for i in 0..10 {
            f.clock.advance(MIN);
            close_to(f.status().worked_ms(), f64::from(i + 1) * MIN, -3);
        }
    }

    #[test]
    fn reflects_a_mutation_immediately_not_after_the_ttl() {
        let f = Fixture::new();
        f.start_ok(Some("task-a"));
        f.clock.advance(5.0 * MIN);
        close_to(f.status().worked_ms(), 5.0 * MIN, -3);

        // Pausing must show up on the very next read, with no clock movement.
        f.pause_for_idle(0.0).unwrap();
        let paused = f.status();
        f.clock.advance(5.0 * MIN);

        assert_eq!(f.status().worked_ms(), paused.worked_ms());
        close_to(f.status().worked_ms(), 5.0 * MIN, -3);
    }

    #[test]
    fn gives_the_same_answer_as_an_un_memoised_read() {
        let f = Fixture::new();
        f.start_ok(Some("task-a"));
        f.clock.advance(3.0 * MIN);
        let memoised = f.status().worked_ms();

        // A fresh service over the same store has an empty memo.
        let fresh = f.reboot();
        assert_eq!(fresh.status().unwrap().worked_ms(), memoised);
    }

    #[test]
    fn actually_reduces_reads_the_point_of_the_change() {
        let f = Fixture::new();
        f.start_ok(Some("task-a"));
        f.store.inner().ledger_reads = 0;

        // The 1s tick calls status() repeatedly with no mutation in between.
        for _ in 0..30 {
            f.clock.advance(100.0);
            f.status();
        }

        assert!(f.store.inner().ledger_reads < 30);
    }

    #[test]
    fn re_reads_once_a_durable_write_bumps_the_epoch() {
        let f = Fixture::new();
        f.start_ok(Some("task-a"));
        f.status();
        let before = f.store.inner().ledger_reads;

        f.stop().unwrap();
        f.status();

        assert!(f.store.inner().ledger_reads > before);
        let _ = running; // keeps the shared import list identical across the parts
    }
}
