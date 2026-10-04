//! Port of `legacy/agent/src/main/services/activity/aggregator.ts`.
//!
//! Counts and timing/geometry statistics only: never key identity, never text.

use serde::Serialize;

use crate::js::math::{div, hypot2, len_f64, sqrt, square};
use crate::js::number::{add, round, strict_eq, sub};

/// One sealed minute. Field order is the TypeScript object literal's.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySample {
    pub bucket_start: f64,
    pub keystrokes: f64,
    pub clicks: f64,
    pub mouse_distance_px: f64,
    pub scroll_events: f64,
    pub iki_cv: Option<f64>,
    pub move_speed_cv: Option<f64>,
    pub path_straightness: Option<f64>,
}

/// Port of `coefficientOfVariation`: population CV, `None` for fewer than two
/// values or a mean of exactly `0`.
#[must_use]
pub fn coefficient_of_variation(values: &[f64]) -> Option<f64> {
    if values.len() < 2 {
        return None;
    }
    let len = len_f64(values.len());
    let mean = div(values.iter().fold(0.0, |a, b| add(a, *b)), len);
    if strict_eq(mean, 0.0) {
        return None;
    }
    let variance = div(
        values
            .iter()
            .fold(0.0, |a, b| add(a, square(sub(*b, mean)))),
        len,
    );
    Some(div(sqrt(variance), mean))
}

#[derive(Debug, Clone, Copy)]
struct LastPoint {
    t: f64,
    x: f64,
    y: f64,
}

/// Port of `ActivityAggregator`.
#[derive(Debug, Clone, Default)]
pub struct ActivityAggregator {
    keystrokes: f64,
    clicks: f64,
    scroll_events: f64,
    mouse_distance_px: f64,
    key_times: Vec<f64>,
    move_speeds: Vec<f64>,
    last: Option<LastPoint>,
    first: Option<(f64, f64)>,
}

impl ActivityAggregator {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    pub fn on_key(&mut self, ts: f64) {
        self.keystrokes = add(self.keystrokes, 1.0);
        self.key_times.push(ts);
    }

    pub fn on_click(&mut self) {
        self.clicks = add(self.clicks, 1.0);
    }

    pub fn on_scroll(&mut self) {
        self.scroll_events = add(self.scroll_events, 1.0);
    }

    pub fn on_move(&mut self, ts: f64, x: f64, y: f64) {
        if self.first.is_none() {
            self.first = Some((x, y));
        }
        if let Some(last) = self.last {
            let dist = hypot2(sub(x, last.x), sub(y, last.y));
            self.mouse_distance_px = add(self.mouse_distance_px, dist);
            let dt = sub(ts, last.t);
            if dt > 0.0 {
                self.move_speeds.push(div(dist, dt));
            }
        }
        self.last = Some(LastPoint { t: ts, x, y });
    }

    /// Emit the sample for this bucket and reset for the next minute.
    pub fn flush(&mut self, bucket_start: f64) -> ActivitySample {
        let intervals: Vec<f64> = self
            .key_times
            .iter()
            .zip(self.key_times.iter().skip(1))
            .map(|(before, after)| sub(*after, *before))
            .collect();
        let path_straightness = match (self.first, self.last) {
            (Some(first), Some(last)) if self.mouse_distance_px > 0.0 => {
                let euclid = hypot2(sub(last.x, first.0), sub(last.y, first.1));
                Some(div(euclid, self.mouse_distance_px))
            }
            _ => None,
        };
        let sample = ActivitySample {
            bucket_start,
            keystrokes: self.keystrokes,
            clicks: self.clicks,
            mouse_distance_px: round(self.mouse_distance_px),
            scroll_events: self.scroll_events,
            iki_cv: coefficient_of_variation(&intervals),
            move_speed_cv: coefficient_of_variation(&self.move_speeds),
            path_straightness,
        };
        *self = Self::default();
        sample
    }

    /// True if nothing happened this bucket (used to skip empty samples).
    #[must_use]
    pub fn is_empty(&self) -> bool {
        strict_eq(self.keystrokes, 0.0)
            && strict_eq(self.clicks, 0.0)
            && strict_eq(self.scroll_events, 0.0)
            && strict_eq(self.mouse_distance_px, 0.0)
            && self.move_speeds.is_empty()
    }
}
