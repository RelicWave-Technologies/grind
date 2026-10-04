//! Pure time-entry / segment domain logic.
//!
//! A `TimeEntry` is a unit of tracked work, composed of non-overlapping, ordered
//! `Segment`s. Worked duration = sum of WORK + MEETING segments. `IDLE_TRIMMED`
//! segments are recorded for the timeline (shown as "idle") but never counted.
//!
//! Invariants (reported by `validate_entry`, enforced nowhere else):
//!  - At most one open segment (`ended_at` is `None`), and it must be the last.
//!  - Segments are ordered by `started_at` and never overlap.
//!  - Every segment is open OR has `ended_at >= started_at`.
//!  - `entry.started_at == segments[0].started_at` (when any segment exists).
//!  - If `entry.ended_at` is set, no segment is open.
//!
//! All functions are pure: they return a new `TimeEntry` and never mutate input.
//!
//! Port of `packages/core/src/segments.ts`. The totals and the validator live in
//! [`crate::segments_report`] to keep each file under the line cap.

use serde::Deserialize;

use crate::error::CoreError;
use crate::js::number::{add, max, number_to_string as fmt};
use crate::types::{AgentCloseReason, Segment, SegmentKind, TimeEntry, TimeEntrySource};

fn segment_error(message: String) -> CoreError {
    CoreError::Segment(message)
}

/// Port of `packages/core/src/segments.ts::getOpenSegment`.
#[must_use]
pub fn get_open_segment(entry: &TimeEntry) -> Option<&Segment> {
    entry.segments.iter().find(|s| s.ended_at.is_none())
}

/// Port of `packages/core/src/segments.ts::CreateArgs`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateArgs {
    pub id: String,
    pub client_uuid: String,
    pub user_id: String,
    pub lark_task_guid: Option<String>,
    pub source: Option<TimeEntrySource>,
    pub started_at: f64,
    pub segment_id: String,
}

/// Create a new running entry with a single open WORK segment.
///
/// Port of `packages/core/src/segments.ts::createTimeEntry`.
#[must_use]
pub fn create_time_entry(args: &CreateArgs) -> TimeEntry {
    TimeEntry {
        id: args.id.clone(),
        client_uuid: args.client_uuid.clone(),
        user_id: args.user_id.clone(),
        lark_task_guid: Some(args.lark_task_guid.clone()),
        source: args.source.unwrap_or(TimeEntrySource::Auto),
        revision: 1.0,
        started_at: args.started_at,
        ended_at: None,
        pause_reason: None,
        close_reason: None,
        segments: vec![Segment {
            id: args.segment_id.clone(),
            kind: SegmentKind::Work,
            started_at: args.started_at,
            ended_at: None,
        }],
    }
}

/// Close the currently-open segment at `at`. No-op if nothing is open (idempotent).
///
/// Port of `packages/core/src/segments.ts::closeOpenSegment`.
pub fn close_open_segment(entry: &TimeEntry, at: f64) -> Result<TimeEntry, CoreError> {
    let mut next = entry.clone();
    let Some(open) = next.segments.iter_mut().find(|s| s.ended_at.is_none()) else {
        return Ok(next);
    };
    if at < open.started_at {
        return Err(segment_error(format!(
            "closeOpenSegment: at ({}) < segment.startedAt ({})",
            fmt(at),
            fmt(open.started_at)
        )));
    }
    open.ended_at = Some(at);
    next.revision = add(entry.revision, 1.0);
    Ok(next)
}

/// Port of the inline `args` type of `packages/core/src/segments.ts::openSegment`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSegmentArgs {
    pub kind: SegmentKind,
    pub at: f64,
    pub segment_id: String,
}

/// Close any open segment at `at`, then append a new open segment of `kind`
/// starting at `at`. Used for WORK -> MEETING transitions and resume-after-idle.
///
/// Port of `packages/core/src/segments.ts::openSegment`. Deliberate quirk,
/// copied: the revision goes up by one from the *input* entry, so a close that
/// already bumped it is not counted twice.
pub fn open_segment(entry: &TimeEntry, args: &OpenSegmentArgs) -> Result<TimeEntry, CoreError> {
    if entry.ended_at.is_some() {
        return Err(segment_error(
            "openSegment: cannot open a segment on a closed entry".to_owned(),
        ));
    }
    let mut closed = close_open_segment(entry, args.at)?;
    if let Some(last) = closed.segments.last()
        && args.at < last.ended_at.unwrap_or(last.started_at)
    {
        return Err(segment_error(format!(
            "openSegment: at ({}) precedes previous segment end",
            fmt(args.at)
        )));
    }
    closed.segments.push(Segment {
        id: args.segment_id.clone(),
        kind: args.kind,
        started_at: args.at,
        ended_at: None,
    });
    closed.revision = add(entry.revision, 1.0);
    closed.pause_reason = None;
    closed.close_reason = None;
    Ok(closed)
}

/// Close the open segment (if any) and mark the entry finished at `at`. Idempotent.
///
/// Port of `packages/core/src/segments.ts::closeTimeEntry`. Quirk, copied: one
/// revision bump from the input entry, and no check that `at` is not before the
/// previous segment's end when nothing was open.
pub fn close_time_entry(entry: &TimeEntry, at: f64) -> Result<TimeEntry, CoreError> {
    if entry.ended_at.is_some() {
        return Ok(entry.clone());
    }
    let mut closed = close_open_segment(entry, at)?;
    closed.revision = add(entry.revision, 1.0);
    closed.ended_at = Some(at);
    closed.pause_reason = None;
    closed.close_reason = Some(AgentCloseReason::Agent);
    Ok(closed)
}

/// Port of the inline `args` type of `packages/core/src/segments.ts::applyIdleDiscard`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleDiscardArgs {
    pub idle_started_at: f64,
    pub resume_at: f64,
    pub idle_segment_id: String,
    pub work_segment_id: String,
}

/// User went idle starting at `idle_started_at` and chose to DISCARD the idle gap.
/// - The open WORK segment is trimmed to end at `idle_started_at`.
/// - The gap `[idle_started_at, resume_at)` is recorded as `IDLE_TRIMMED` (not counted).
/// - A fresh open WORK segment starts at `resume_at`.
///
/// Edge: if `idle_started_at` <= the open segment's start, the whole open segment
/// was idle, so it is dropped entirely and `IDLE_TRIMMED` covers `[origStart, resume_at)`.
///
/// Port of `packages/core/src/segments.ts::applyIdleDiscard`. Quirk, copied: a
/// `resume_at` before the open segment's start (but not before `idle_started_at`)
/// yields a negative-length `IDLE_TRIMMED` segment instead of an error.
pub fn apply_idle_discard(
    entry: &TimeEntry,
    args: &IdleDiscardArgs,
) -> Result<TimeEntry, CoreError> {
    if entry.ended_at.is_some() {
        return Err(segment_error(
            "applyIdleDiscard: entry already closed".to_owned(),
        ));
    }
    let Some(open) = get_open_segment(entry).cloned() else {
        return Err(segment_error(
            "applyIdleDiscard: no open segment".to_owned(),
        ));
    };
    if args.resume_at < args.idle_started_at {
        return Err(segment_error(format!(
            "applyIdleDiscard: resumeAt ({}) < idleStartedAt ({})",
            fmt(args.resume_at),
            fmt(args.idle_started_at)
        )));
    }
    let mut next = entry.clone();
    let effective_idle_start = max(args.idle_started_at, open.started_at);
    let idle_gap_start = if open.started_at > args.idle_started_at {
        open.started_at
    } else {
        effective_idle_start
    };
    let idle_segment = |started_at| Segment {
        id: args.idle_segment_id.clone(),
        kind: SegmentKind::IdleTrimmed,
        started_at,
        ended_at: Some(args.resume_at),
    };
    // Position of the open segment: `get_open_segment` found it, so it exists.
    let index = next.segments.iter().position(|s| s.ended_at.is_none());
    if let Some(slot) = index.and_then(|i| next.segments.get_mut(i)) {
        if effective_idle_start <= open.started_at {
            *slot = idle_segment(open.started_at);
        } else {
            slot.ended_at = Some(effective_idle_start);
            next.segments.push(idle_segment(idle_gap_start));
        }
    }
    next.segments.push(Segment {
        id: args.work_segment_id.clone(),
        kind: SegmentKind::Work,
        started_at: args.resume_at,
        ended_at: None,
    });
    next.revision = add(entry.revision, 1.0);
    next.pause_reason = None;
    next.close_reason = None;
    Ok(next)
}

/// Crash / unexpected-shutdown recovery: an entry was left with an open segment,
/// but we only trust activity up to `last_known_active_at`. Close the open segment
/// there and finish the entry, so we never over-credit the offline gap.
///
/// Port of `packages/core/src/segments.ts::recoverStaleEntry`. Quirk, copied:
/// the close reason is `AGENT`, not `AGENT_RECOVERY`.
pub fn recover_stale_entry(
    entry: &TimeEntry,
    last_known_active_at: f64,
) -> Result<TimeEntry, CoreError> {
    if entry.ended_at.is_some() {
        return Ok(entry.clone());
    }
    let at = match get_open_segment(entry) {
        Some(open) => max(last_known_active_at, open.started_at),
        None => last_known_active_at,
    };
    close_time_entry(entry, at)
}
