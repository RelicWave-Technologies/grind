//! Port of `legacy/agent/src/main/services/capture/scheduler.ts`.

use crate::js::number::{max, round};

/// Input must have been quiet this long for a capture to go ahead.
pub const CAPTURE_QUIET_SECONDS: f64 = 2.0;
/// Never hold a capture back longer than this many attempts.
pub const MAX_CAPTURE_DEFERRALS: f64 = 3.0;
/// How long to wait before re-checking for a gap in input.
pub const CAPTURE_DEFER_MS: f64 = 2_000.0;

/// Port of `nextDelayMs`: exact, with a defensive 1 s floor.
#[must_use]
pub fn next_delay_ms(interval_ms: f64) -> f64 {
    max(1000.0, round(interval_ms))
}

/// Port of `shouldDeferCapture`: hold a capture back while the person is
/// mid-interaction, but never forever.
#[must_use]
pub fn should_defer_capture(idle_seconds: f64, deferrals: f64) -> bool {
    if deferrals >= MAX_CAPTURE_DEFERRALS {
        return false;
    }
    idle_seconds < CAPTURE_QUIET_SECONDS
}
