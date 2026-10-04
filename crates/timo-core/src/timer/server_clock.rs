//! The server-aligned clock.
//!
//! Port of `legacy/agent/src/main/services/serverClock.ts`, with the module's
//! global state made a struct and `performance.now()` / `Date.now()` made two
//! injected sources. The reasoning in the TypeScript's header comment applies
//! unchanged: `now = anchorServer + (monotonic() - anchorMonotonic)`, corrections
//! wait while a timer runs, and a step is taken only when nothing is measured.
//!
//! The real sources belong to the shell: a monotonic reading in fractional
//! milliseconds (`Instant`-based, matching `performance.now()` per OS) and the
//! device wall clock (`SystemTime`-based). `timo-core` reads neither.

use crate::js::date::{DateParse, parse};
use crate::js::math::{abs, div};
use crate::js::number::{add, max, sub};

/// Ignore corrections below this: normal jitter, not drift worth chasing.
const MIN_SIGNIFICANT_OFFSET_MS: f64 = 1_000.0;

/// `performance.now()`: monotonic, unaffected by wall-clock edits.
pub trait MonotonicClock: Send {
    fn now_ms(&self) -> f64;
}

/// `Date.now()`: the device wall clock (D-frame).
pub trait DeviceClock: Send {
    fn now_ms(&self) -> f64;
}

/// One known server instant paired with one monotonic reading.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Anchor {
    server_ms: f64,
    mono_ms: f64,
}

/// Port of the module state of `serverClock.ts`.
pub struct ServerClock<M: MonotonicClock, D: DeviceClock> {
    monotonic: M,
    device: D,
    anchor: Option<Anchor>,
    deferred: Option<Anchor>,
    tracking_active: bool,
    samples: u64,
}

impl<M: MonotonicClock, D: DeviceClock> std::fmt::Debug for ServerClock<M, D> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ServerClock")
            .field("anchor", &self.anchor)
            .field("deferred", &self.deferred)
            .field("tracking_active", &self.tracking_active)
            .field("samples", &self.samples)
            .finish_non_exhaustive()
    }
}

impl<M: MonotonicClock, D: DeviceClock> ServerClock<M, D> {
    /// A fresh clock (`__resetServerClock(monotonic)`).
    #[must_use]
    pub const fn new(monotonic: M, device: D) -> Self {
        Self {
            monotonic,
            device,
            anchor: None,
            deferred: None,
            tracking_active: false,
            samples: 0,
        }
    }

    /// `project`: lazily seeds the anchor from the device clock on first use.
    fn project(&mut self, mono_ms: f64) -> f64 {
        let anchor = if let Some(anchor) = self.anchor {
            anchor
        } else {
            let seeded = Anchor {
                server_ms: self.device.now_ms(),
                mono_ms,
            };
            self.anchor = Some(seeded);
            seeded
        };
        add(anchor.server_ms, sub(mono_ms, anchor.mono_ms))
    }

    /// `serverAlignedNow`: advances at real rate between anchors.
    pub fn server_aligned_now(&mut self) -> f64 {
        let mono = self.monotonic.now_ms();
        self.project(mono)
    }

    /// `noteServerTime`: fold one server timestamp in; the resulting offset from
    /// the device clock, or `None` if the inputs are unusable.
    pub fn note_server_time(
        &mut self,
        server_time_iso: &str,
        request_started_at_ms: f64,
        received_at_ms: f64,
    ) -> Option<f64> {
        let stamped_ms = match parse(server_time_iso) {
            DateParse::Time(t) => t,
            DateParse::Invalid | DateParse::Unsupported => return None,
        };
        if !request_started_at_ms.is_finite() || !received_at_ms.is_finite() {
            return None;
        }
        // Symmetric latency: the stamp was taken mid-flight.
        let rtt_ms = max(0.0, sub(received_at_ms, request_started_at_ms));
        let candidate = Anchor {
            server_ms: add(stamped_ms, div(rtt_ms, 2.0)),
            mono_ms: self.monotonic.now_ms(),
        };
        self.samples += 1;
        let drift_ms = sub(candidate.server_ms, self.project(candidate.mono_ms));
        if abs(drift_ms) < MIN_SIGNIFICANT_OFFSET_MS {
            self.deferred = None;
            return Some(self.server_clock_offset_ms());
        }
        // Stepping mid-session would add or destroy worked time: hold it.
        if self.tracking_active {
            self.deferred = Some(candidate);
            return Some(self.server_clock_offset_ms());
        }
        self.anchor = Some(candidate);
        self.deferred = None;
        Some(self.server_clock_offset_ms())
    }

    /// `setServerClockTrackingActive`. Safe to call repeatedly with one value.
    pub fn set_tracking_active(&mut self, active: bool) {
        if self.tracking_active == active {
            return;
        }
        self.tracking_active = active;
        if active || self.deferred.is_none() {
            return;
        }
        // A held anchor does not go stale: `now` derives from the monotonic
        // delta since it was captured.
        self.anchor = self.deferred.take();
    }

    /// `serverClockOffsetMs`: positive means this machine is BEHIND.
    pub fn server_clock_offset_ms(&mut self) -> f64 {
        if self.samples == 0 {
            return 0.0;
        }
        let aligned = self.server_aligned_now();
        sub(aligned, self.device.now_ms())
    }

    /// `hasServerClockSample`.
    #[must_use]
    pub const fn has_sample(&self) -> bool {
        self.samples > 0
    }

    /// `hasDeferredServerClockCorrection`.
    #[must_use]
    pub const fn has_deferred_correction(&self) -> bool {
        self.deferred.is_some()
    }
}
