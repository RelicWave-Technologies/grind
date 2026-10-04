//! Port of `activityWindowForShot` in
//! `legacy/agent/src/main/services/capture/index.ts`.

use serde::Serialize;

use crate::js::number::{add, min, sub};

/// The `{ from, to }` window.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct ActivityWindowRange {
    pub from: f64,
    pub to: f64,
}

/// Port of `activityWindowForShot({ capturedAt, olderCapturedAt?, defaultWindowMs })`:
/// the window of activity minutes a screenshot's bars are computed from.
#[must_use]
pub fn activity_window_for_shot(
    captured_at: f64,
    older_captured_at: Option<f64>,
    default_window_ms: f64,
) -> ActivityWindowRange {
    let to = add(captured_at, 60_000.0);
    let partition_from = match older_captured_at {
        Some(older) => add(older, 60_000.0),
        None => sub(captured_at, default_window_ms),
    };
    let from = min(partition_from, sub(captured_at, 60_000.0));
    ActivityWindowRange { from, to }
}
