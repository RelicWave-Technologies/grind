//! 1:1 port of `legacy/agent/src/main/services/serverClock.test.ts`. The module's
//! globals are a `ServerClock` struct here, with `performance.now()` and
//! `Date.now()` injected (the shipped monotonic source belongs to the shell).
#![allow(
    clippy::float_cmp,
    clippy::float_arithmetic,
    clippy::unwrap_used,
    clippy::panic,
    reason = "the ported tests compare the exact doubles the TypeScript tests compare, with the same arithmetic"
)]

use std::sync::{Arc, Mutex, PoisonError};

use timo_core::js::date::{DateParse, parse};
use timo_core::js::iso::to_iso_string;
use timo_core::timer::server_clock::{DeviceClock, MonotonicClock, ServerClock};

const MINUTE: f64 = 60_000.0;

/// `expect(a).toBeCloseTo(b, digits)`.
fn close_to(received: f64, expected: f64, digits: i32) {
    let tolerance = 10_f64.powi(-digits) / 2.0;
    assert!(
        (expected - received).abs() < tolerance,
        "{received} is not within {tolerance} of {expected}"
    );
}

#[allow(
    clippy::struct_field_names,
    reason = "the TypeScript names these `trueNowMs`, `monoMs`, `skewMs`"
)]
struct State {
    true_now_ms: f64,
    mono_ms: f64,
    skew_ms: f64,
}

/// `device(skewMs)`: a wall clock `skewMs` away from the server, with a monotonic
/// source that keeps running correctly regardless.
#[derive(Clone)]
struct Device(Arc<Mutex<State>>);

impl Device {
    fn new(skew_ms: f64) -> Self {
        // Date.UTC(2026, 7, 8, 12, 0, 0)
        let DateParse::Time(true_start) = parse("2026-08-08T12:00:00.000Z") else {
            panic!("date")
        };
        Self(Arc::new(Mutex::new(State {
            true_now_ms: true_start,
            mono_ms: 5_000.0, // performance.now() starts at process launch, not 0
            skew_ms,
        })))
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Advance real time; both the wall clock and the monotonic source move.
    fn advance(&self, ms: f64) {
        let mut s = self.state();
        s.true_now_ms += ms;
        s.mono_ms += ms;
    }

    /// The user (or a buggy NTP client) drags the wall clock somewhere else.
    fn jump_wall_clock(&self, ms: f64) {
        self.state().skew_ms += ms;
    }

    /// The machine sleeps: real time marches on, the monotonic source may not.
    fn suspend(&self, ms: f64) {
        self.state().true_now_ms += ms;
    }

    fn server_iso(&self) -> String {
        to_iso_string(self.state().true_now_ms).unwrap()
    }

    fn true_now(&self) -> f64 {
        self.state().true_now_ms
    }

    fn device_now(&self) -> f64 {
        let s = self.state();
        s.true_now_ms + s.skew_ms
    }
}

struct Mono(Device);
struct Wall(Device);

impl MonotonicClock for Mono {
    fn now_ms(&self) -> f64 {
        self.0.state().mono_ms
    }
}

impl DeviceClock for Wall {
    fn now_ms(&self) -> f64 {
        self.0.device_now()
    }
}

type Clock = ServerClock<Mono, Wall>;

/// `installDeviceClock(d)`: a fresh clock over the simulated device.
fn install(d: &Device) -> Clock {
    ServerClock::new(Mono(d.clone()), Wall(d.clone()))
}

/// One heartbeat round trip taking `rtt_ms`.
fn heartbeat(clock: &mut Clock, d: &Device, rtt_ms: f64) -> Option<f64> {
    let started_at = d.device_now();
    d.advance(rtt_ms / 2.0);
    let stamped = d.server_iso(); // the server stamps mid-flight
    d.advance(rtt_ms / 2.0);
    clock.note_server_time(&stamped, started_at, d.device_now())
}

mod server_aligned_now {
    use super::*;

    #[test]
    fn falls_back_to_the_device_clock_before_any_server_sample() {
        let d = Device::new(10.0 * MINUTE);
        let mut clock = install(&d);

        assert!(!clock.has_sample());
        assert_eq!(clock.server_aligned_now(), d.device_now());
    }

    #[test]
    fn pulls_a_fast_device_clock_onto_server_time() {
        let d = Device::new(10.0 * MINUTE);
        let mut clock = install(&d);

        heartbeat(&mut clock, &d, 0.0);

        close_to(clock.server_aligned_now(), d.true_now(), -1);
        assert!(clock.has_sample());
        close_to(clock.server_clock_offset_ms(), -10.0 * MINUTE, -2);
    }

    #[test]
    fn pushes_a_slow_device_clock_forward_onto_server_time() {
        let d = Device::new(-7.0 * MINUTE);
        let mut clock = install(&d);

        heartbeat(&mut clock, &d, 0.0);

        close_to(clock.server_aligned_now(), d.true_now(), -1);
        close_to(clock.server_clock_offset_ms(), 7.0 * MINUTE, -2);
    }

    #[test]
    fn splits_round_trip_latency_instead_of_charging_it_all_to_the_offset() {
        let d = Device::new(0.0);
        let mut clock = install(&d);

        // The round trip has to be long enough that mishandling it lands ABOVE the
        // significance threshold: otherwise the resulting error is written off as
        // jitter and the test passes no matter what the code does.
        heartbeat(&mut clock, &d, 6_000.0);

        // Symmetric latency: the stamp was taken mid-flight, so half the RTT is
        // added back. Charging the whole trip would show up as a 3s offset.
        assert!(clock.server_clock_offset_ms().abs() < 500.0);
    }
}

// A clamped `Date.now() + offset` clock stops dead for the length of the skew
// after the first correction, and a running timer accrues nothing.
mod the_freeze_regression {
    use super::*;

    #[test]
    fn keeps_advancing_at_real_rate_through_a_large_backwards_correction() {
        let d = Device::new(10.0 * MINUTE);
        let mut clock = install(&d);

        clock.server_aligned_now(); // the 1s tray tick reads the clock before the first sample
        heartbeat(&mut clock, &d, 0.0);

        let mut previous = clock.server_aligned_now();
        for _ in 0..20 {
            d.advance(MINUTE);
            let current = clock.server_aligned_now();
            close_to(current - previous, MINUTE, -2);
            previous = current;
        }
    }

    #[test]
    fn loses_no_worked_time_across_the_correction() {
        let d = Device::new(10.0 * MINUTE);
        let mut clock = install(&d);

        clock.set_tracking_active(true);
        let started_at = clock.server_aligned_now();
        heartbeat(&mut clock, &d, 0.0);
        d.advance(20.0 * MINUTE);

        let worked_ms = clock.server_aligned_now() - started_at;
        close_to(worked_ms, 20.0 * MINUTE, -3);
    }

    #[test]
    fn never_returns_a_smaller_value_than_it_last_returned_while_tracking() {
        let d = Device::new(10.0 * MINUTE);
        let mut clock = install(&d);
        clock.set_tracking_active(true);

        let mut readings = vec![clock.server_aligned_now()];
        for i in 0..30 {
            if i == 3 {
                heartbeat(&mut clock, &d, 0.0);
            }
            if i == 17 {
                heartbeat(&mut clock, &d, 250.0);
            }
            if i == 22 {
                d.suspend(4.0 * MINUTE);
            }
            d.advance(30_000.0);
            readings.push(clock.server_aligned_now());
        }

        for pair in readings.windows(2) {
            assert!(pair[1] >= pair[0]);
        }
    }
}

mod corrections_while_a_timer_is_running {
    use super::*;

    #[test]
    fn holds_a_correction_until_tracking_stops() {
        let d = Device::new(0.0);
        let mut clock = install(&d);
        heartbeat(&mut clock, &d, 0.0);

        clock.set_tracking_active(true);
        d.suspend(9.0 * MINUTE); // the laptop slept; the anchor is now behind
        d.advance(MINUTE);
        heartbeat(&mut clock, &d, 0.0);

        assert!(clock.has_deferred_correction());

        clock.set_tracking_active(false);
        assert!(!clock.has_deferred_correction());
        close_to(clock.server_aligned_now(), d.true_now(), -2);
    }

    #[test]
    fn costs_no_worked_time_while_the_correction_is_held() {
        let d = Device::new(0.0);
        let mut clock = install(&d);
        heartbeat(&mut clock, &d, 0.0);

        clock.set_tracking_active(true);
        let started_at = clock.server_aligned_now();
        d.suspend(8.0 * MINUTE);
        for _ in 0..6 {
            d.advance(5.0 * MINUTE);
            heartbeat(&mut clock, &d, 0.0);
        }

        close_to(clock.server_aligned_now() - started_at, 30.0 * MINUTE, -3);
    }

    #[test]
    fn does_not_go_stale_a_held_correction_accounts_for_the_wait() {
        let d = Device::new(0.0);
        let mut clock = install(&d);
        heartbeat(&mut clock, &d, 0.0);

        clock.set_tracking_active(true);
        d.suspend(5.0 * MINUTE);
        heartbeat(&mut clock, &d, 0.0);
        d.advance(45.0 * MINUTE); // long session before the timer stops
        clock.set_tracking_active(false);

        close_to(clock.server_aligned_now(), d.true_now(), -2);
    }

    #[test]
    fn holds_even_the_very_first_sample_when_a_timer_is_already_open() {
        // An entry that began before the first sample lives in the device's frame.
        // Correcting mid-entry would rewrite what it has already accrued, so the
        // entry keeps its frame and the correction lands the moment it stops.
        let d = Device::new(12.0 * MINUTE);
        let mut clock = install(&d);

        clock.set_tracking_active(true);
        let started_at = clock.server_aligned_now();
        heartbeat(&mut clock, &d, 0.0);
        d.advance(6.0 * MINUTE);

        assert!(clock.has_deferred_correction());
        close_to(clock.server_aligned_now() - started_at, 6.0 * MINUTE, -3);

        clock.set_tracking_active(false);
        close_to(clock.server_aligned_now(), d.true_now(), -2);
    }
}

mod robustness {
    use super::*;

    #[test]
    fn ignores_the_device_clock_being_edited_underneath_it() {
        // The Kronos property: once anchored, `now` comes from the monotonic
        // source, so tampering with the system clock moves nothing.
        let d = Device::new(0.0);
        let mut clock = install(&d);
        heartbeat(&mut clock, &d, 0.0);

        let before = clock.server_aligned_now();
        d.jump_wall_clock(3.0 * 60.0 * MINUTE); // user sets the clock three hours ahead
        let after = clock.server_aligned_now();

        assert_eq!(after, before);
    }

    #[test]
    fn ignores_jitter_below_the_significance_threshold() {
        let d = Device::new(0.0);
        let mut clock = install(&d);
        heartbeat(&mut clock, &d, 0.0);
        let anchored = clock.server_aligned_now();

        d.suspend(200.0);
        clock.set_tracking_active(true);
        heartbeat(&mut clock, &d, 0.0);

        assert!(!clock.has_deferred_correction());
        assert_eq!(clock.server_aligned_now(), anchored);
    }

    /// The shipped default is `performance.now()`, which the shell injects in
    /// Rust. This checks the property that matters of whatever monotonic source it
    /// supplies: once seeded, a yanked device clock does not move `now`.
    #[test]
    fn is_driven_by_a_monotonic_source_in_production_not_the_device_clock() {
        let d = Device::new(0.0);
        let mut clock = install(&d);

        let first = clock.server_aligned_now(); // seeds the anchor from the device clock
        d.jump_wall_clock(60.0 * MINUTE); // user yanks the clock forward an hour
        let second = clock.server_aligned_now();

        assert!(second - first < 1_000.0);
    }

    #[test]
    fn ignores_an_unparseable_server_timestamp() {
        let d = Device::new(4.0 * MINUTE);
        let mut clock = install(&d);

        assert_eq!(
            clock.note_server_time("not-a-date", d.device_now(), d.device_now()),
            None
        );
        assert!(!clock.has_sample());
        assert_eq!(clock.server_aligned_now(), d.device_now());
    }

    #[test]
    fn ignores_non_finite_local_timings() {
        let d = Device::new(0.0);
        let mut clock = install(&d);

        assert_eq!(
            clock.note_server_time(&d.server_iso(), f64::NAN, d.device_now()),
            None
        );
        assert!(!clock.has_sample());
    }

    #[test]
    fn survives_repeated_tracking_toggles_with_nothing_pending() {
        let d = Device::new(0.0);
        let mut clock = install(&d);
        heartbeat(&mut clock, &d, 0.0);
        let anchored = clock.server_aligned_now();

        for _ in 0..5 {
            clock.set_tracking_active(true);
            clock.set_tracking_active(false);
        }

        assert_eq!(clock.server_aligned_now(), anchored);
    }
}
