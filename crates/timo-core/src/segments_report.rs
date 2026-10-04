//! Totals and the invariant validator for time entries.
//!
//! Port of the second half of `packages/core/src/segments.ts`: `totalWorkedMs`,
//! `totalIdleTrimmedMs` and `validateEntry`.

use std::collections::HashSet;

use crate::error::CoreError;
use crate::js::number::{add, max, number_to_string as fmt, strict_eq, sub};
use crate::types::{Segment, TimeEntry, is_counted};

/// Total worked milliseconds (WORK + MEETING). The open segment, if any, is
/// counted up to `now`. Errors if there is an open counted segment and `now` is `None`.
///
/// Port of `packages/core/src/segments.ts::totalWorkedMs`.
pub fn total_worked_ms(entry: &TimeEntry, now: Option<f64>) -> Result<f64, CoreError> {
    let mut total = 0.0;
    for s in &entry.segments {
        if !is_counted(s.kind) {
            continue;
        }
        let Some(end) = s.ended_at.or(now) else {
            return Err(CoreError::Segment(
                "totalWorkedMs: open segment requires `now`".to_owned(),
            ));
        };
        total = add(total, max(0.0, sub(end, s.started_at)));
    }
    Ok(total)
}

/// Total milliseconds recorded as trimmed idle (for timeline/audit display).
///
/// Port of `packages/core/src/segments.ts::totalIdleTrimmedMs`.
#[must_use]
pub fn total_idle_trimmed_ms(entry: &TimeEntry) -> f64 {
    let mut total = 0.0;
    for s in &entry.segments {
        if s.kind != crate::types::SegmentKind::IdleTrimmed {
            continue;
        }
        let Some(end) = s.ended_at else { continue };
        total = add(total, max(0.0, sub(end, s.started_at)));
    }
    total
}

/// Validate all invariants. Returns the list of violations (empty = valid).
///
/// Port of `packages/core/src/segments.ts::validateEntry`.
#[must_use]
pub fn validate_entry(entry: &TimeEntry) -> Vec<String> {
    let Some(first) = entry.segments.first() else {
        return vec!["entry has no segments".to_owned()];
    };
    let mut errors = Vec::new();
    if !strict_eq(entry.started_at, first.started_at) {
        errors.push(format!(
            "entry.startedAt ({}) !== first segment.startedAt ({})",
            fmt(entry.started_at),
            fmt(first.started_at)
        ));
    }
    let open_count = check_segments(&entry.segments, &mut errors);
    if open_count > 1 {
        errors.push(format!("{open_count} open segments (max 1)"));
    }
    if entry.ended_at.is_some() && open_count > 0 {
        errors.push("entry closed but has an open segment".to_owned());
    }
    errors
}

/// The per-segment loop of `validateEntry`; returns the number of open segments.
fn check_segments(segs: &[Segment], errors: &mut Vec<String>) -> usize {
    let mut seen_ids = HashSet::new();
    let mut open_count = 0;
    for (i, s) in segs.iter().enumerate() {
        if !seen_ids.insert(s.id.as_str()) {
            errors.push(format!("duplicate segment id {}", s.id));
        }
        match s.ended_at {
            None => {
                open_count += 1;
                if i + 1 != segs.len() {
                    errors.push(format!("open segment at index {i} is not last"));
                }
            }
            Some(end) if end < s.started_at => errors.push(format!(
                "segment {i}: endedAt ({}) < startedAt ({})",
                fmt(end),
                fmt(s.started_at)
            )),
            Some(_) => {}
        }
        if let Some(prev) = i.checked_sub(1).and_then(|p| segs.get(p)) {
            let prev_end = prev.ended_at.unwrap_or(prev.started_at);
            if s.started_at < prev_end {
                errors.push(format!(
                    "segment {i} overlaps previous (start {} < prev end {})",
                    fmt(s.started_at),
                    fmt(prev_end)
                ));
            }
        }
    }
    open_count
}
