//! Close-boundary helpers and the per-task interval union.
//!
//! Port of the module-level functions at the end of
//! `legacy/agent/src/main/services/timer/timerService.ts`.

use crate::js::number::{add, max, sort_cmp, sub};
use crate::types::TimeEntry;

/// Port of `timerService.ts::latestSegmentBoundary`.
#[must_use]
pub fn latest_segment_boundary(entry: &TimeEntry) -> f64 {
    entry
        .segments
        .iter()
        .fold(entry.started_at, |latest, segment| {
            let end = segment.ended_at.unwrap_or(segment.started_at);
            max(max(latest, segment.started_at), end)
        })
}

/// Port of `timerService.ts::safeCloseAt`: never before an already-closed
/// segment's end (and so silently collapses a wrong-frame boundary to zero).
#[must_use]
pub fn safe_close_at(entry: &TimeEntry, at: f64) -> f64 {
    max(at, latest_segment_boundary(entry))
}

/// One `{start, end}` of `workedMsByTask`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Interval {
    pub start: f64,
    pub end: f64,
}

/// Port of `timerService.ts::intervalUnionMs` (sorts its input in place, like
/// the TypeScript). Float operations in the TypeScript's order.
#[must_use]
pub fn interval_union_ms(values: &mut [Interval]) -> f64 {
    values.sort_by(|a, b| sort_cmp(a.start, b.start).then_with(|| sort_cmp(a.end, b.end)));
    let mut total = 0.0;
    let mut current: Option<Interval> = None;
    for value in values.iter() {
        match &mut current {
            None => current = Some(*value),
            Some(c) if value.start <= c.end => c.end = max(c.end, value.end),
            Some(c) => {
                total = add(total, sub(c.end, c.start));
                *c = *value;
            }
        }
    }
    current.map_or(total, |c| sub(add(total, c.end), c.start))
}
