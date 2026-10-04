//! Port of `legacy/agent/src/main/services/activity/percent.ts`: a window's
//! summed activity as 0-100% keyboard and mouse bars.

use serde::{Deserialize, Serialize};

use crate::js::math::{div, mul};
use crate::js::number::{max, min, round};

pub const KEYS_SAT_PER_MIN: f64 = 120.0;
pub const CLICKS_SAT_PER_MIN: f64 = 40.0;
pub const SCROLL_SAT_PER_MIN: f64 = 40.0;
pub const MOUSE_PX_SAT_PER_MIN: f64 = 6000.0;

/// Port of `ActivityWindow`.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityWindow {
    pub minutes: f64,
    pub keystrokes: f64,
    pub clicks: f64,
    pub mouse_distance_px: f64,
    pub scroll_events: f64,
}

/// Port of `ActivityPercent`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct ActivityPercent {
    pub keyboard: f64,
    pub mouse: f64,
}

/// `const clampPct = (x) => Math.max(0, Math.min(100, Math.round(x)))`.
fn clamp_pct(x: f64) -> f64 {
    max(0.0, min(100.0, round(x)))
}

/// Port of `activityPercent`.
#[must_use]
pub fn activity_percent(w: &ActivityWindow) -> ActivityPercent {
    if w.minutes <= 0.0 {
        return ActivityPercent {
            keyboard: 0.0,
            mouse: 0.0,
        };
    }
    let keyboard = clamp_pct(mul(
        div(div(w.keystrokes, w.minutes), KEYS_SAT_PER_MIN),
        100.0,
    ));
    let clicks_pm = div(div(w.clicks, w.minutes), CLICKS_SAT_PER_MIN);
    let scroll_pm = div(div(w.scroll_events, w.minutes), SCROLL_SAT_PER_MIN);
    let dist_pm = div(div(w.mouse_distance_px, w.minutes), MOUSE_PX_SAT_PER_MIN);
    let busiest = max(max(clicks_pm, scroll_pm), dist_pm);
    ActivityPercent {
        keyboard,
        mouse: clamp_pct(mul(busiest, 100.0)),
    }
}
