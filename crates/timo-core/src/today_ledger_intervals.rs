//! Interval maths behind `reconcileTodayLedger`: which counted intervals fall in
//! the window, which entries overlap, and the length of their union.
//!
//! Port of the helper functions of `packages/core/src/todayLedger.ts`.

use std::collections::HashSet;

use crate::js::number::{add, max, min, sort_cmp, sub};
use crate::today_ledger::LedgerProjectionEntry;
use crate::types::is_counted;

/// Port of the inline interval type of `countedIntervals`.
#[derive(Debug, Clone, PartialEq)]
pub struct CountedInterval<'a> {
    pub entry_id: &'a str,
    pub start: f64,
    pub end: f64,
}

/// Port of `packages/core/src/todayLedger.ts::countedIntervals`.
#[must_use]
pub fn counted_intervals(
    entries: &[LedgerProjectionEntry],
    window_start: f64,
    window_end: f64,
    now: f64,
) -> Vec<CountedInterval<'_>> {
    let effective_now = min(now, window_end);
    let mut intervals: Vec<_> = entries
        .iter()
        .flat_map(|item| {
            item.entry
                .segments
                .iter()
                .filter(|segment| is_counted(segment.kind))
                .map(|segment| CountedInterval {
                    entry_id: item.entry.id.as_str(),
                    start: max(window_start, segment.started_at),
                    end: min(window_end, segment.ended_at.unwrap_or(effective_now)),
                })
        })
        .filter(|interval| interval.end > interval.start)
        .collect();
    intervals.sort_by(|a, b| sort_cmp(a.start, b.start).then(sort_cmp(a.end, b.end)));
    intervals
}

/// Port of `packages/core/src/todayLedger.ts::overlappingEntryIds`.
#[must_use]
pub fn overlapping_entry_ids<'a>(intervals: &[CountedInterval<'a>]) -> HashSet<&'a str> {
    let mut overlapping = HashSet::new();
    let mut active: Vec<(&str, f64)> = Vec::new();
    for interval in intervals {
        active.retain(|candidate| candidate.1 > interval.start);
        for candidate in &active {
            if candidate.0 == interval.entry_id {
                continue;
            }
            overlapping.insert(candidate.0);
            overlapping.insert(interval.entry_id);
        }
        active.push((interval.entry_id, interval.end));
    }
    overlapping
}

/// Port of `packages/core/src/todayLedger.ts::unionDuration`. The final
/// `total + end - start` associates left to right, as in JavaScript.
#[must_use]
pub fn union_duration(intervals: &[CountedInterval<'_>]) -> f64 {
    let mut total = 0.0;
    let mut current: Option<(f64, f64)> = None;
    for interval in intervals {
        let Some((start, end)) = current else {
            current = Some((interval.start, interval.end));
            continue;
        };
        if interval.start <= end {
            current = Some((start, max(end, interval.end)));
            continue;
        }
        total = add(total, sub(end, start));
        current = Some((interval.start, interval.end));
    }
    match current {
        None => total,
        Some((start, end)) => sub(add(total, end), start),
    }
}
