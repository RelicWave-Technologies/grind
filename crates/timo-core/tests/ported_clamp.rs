//! 1:1 port of `packages/core/src/clamp.test.ts`.
#![cfg(test)]
#![allow(
    clippy::float_cmp,
    clippy::float_arithmetic,
    reason = "the ported tests compare the exact doubles the TypeScript tests compare, and write expected values with the same arithmetic"
)]

use timo_core::{
    ClampResult, DEFAULT_CLOCK_SKEW_MS, Segment, SegmentKind, TimeEntry, TimeEntrySource,
    clamp_entry_to_server_clock,
};

const NOW: f64 = 1_700_000_000_000.0;
const MIN: f64 = 60.0 * 1000.0;

/// Port of the test's `entry({ startedAt?, endedAt?, segments })` helper.
fn entry(started_at: Option<f64>, ended_at: Option<f64>, segments: Vec<Segment>) -> TimeEntry {
    TimeEntry {
        id: "e1".into(),
        client_uuid: "cu1".into(),
        user_id: "u1".into(),
        lark_task_guid: None,
        source: TimeEntrySource::Auto,
        revision: 1.0,
        started_at: started_at.unwrap_or(NOW - 10.0 * MIN),
        ended_at,
        pause_reason: None,
        close_reason: None,
        segments,
        shape: timo_core::types::EntryShape::default(),
    }
}

fn work(id: &str, kind: SegmentKind, started_at: f64, ended_at: Option<f64>) -> Segment {
    Segment {
        id: id.into(),
        kind,
        started_at,
        ended_at,
    }
}

fn clamp(e: &TimeEntry) -> ClampResult {
    clamp_entry_to_server_clock(e, NOW, None)
}

mod clamp_entry_to_server_clock {
    use super::*;

    #[test]
    fn leaves_an_honest_past_entry_untouched() {
        let e = entry(
            Some(NOW - 10.0 * MIN),
            Some(NOW - 1.0 * MIN),
            vec![work(
                "s1",
                SegmentKind::Work,
                NOW - 10.0 * MIN,
                Some(NOW - 1.0 * MIN),
            )],
        );
        let r = clamp(&e);
        assert!(!r.adjusted);
        assert_eq!(r.notes, Vec::<String>::new());
        assert_eq!(r.entry, e);
    }

    #[test]
    fn clamps_a_future_segment_end_down_to_the_ceiling_fast_client_clock() {
        // Client clock 1h ahead: segment claims it ends an hour in the future.
        let e = entry(
            Some(NOW - 5.0 * MIN),
            Some(NOW + 60.0 * MIN),
            vec![work(
                "s1",
                SegmentKind::Work,
                NOW - 5.0 * MIN,
                Some(NOW + 60.0 * MIN),
            )],
        );
        let r = clamp(&e);
        assert!(r.adjusted);
        let ceiling = NOW + DEFAULT_CLOCK_SKEW_MS;
        assert_eq!(r.entry.segments[0].ended_at, Some(ceiling));
        assert_eq!(r.entry.ended_at, Some(ceiling));
        // The honest start is preserved.
        assert_eq!(r.entry.segments[0].started_at, NOW - 5.0 * MIN);
    }

    #[test]
    fn allows_timestamps_within_the_skew_window_benign_drift() {
        let within = NOW + DEFAULT_CLOCK_SKEW_MS - 1.0; // just inside the ceiling
        let e = entry(
            Some(NOW - 5.0 * MIN),
            Some(within),
            vec![work("s1", SegmentKind::Work, NOW - 5.0 * MIN, Some(within))],
        );
        let r = clamp(&e);
        assert!(!r.adjusted);
        assert_eq!(r.entry.segments[0].ended_at, Some(within));
    }

    #[test]
    fn never_touches_past_slow_client_clock_under_credits_safe() {
        let e = entry(
            Some(NOW - 100.0 * MIN),
            Some(NOW - 50.0 * MIN),
            vec![work(
                "s1",
                SegmentKind::Work,
                NOW - 100.0 * MIN,
                Some(NOW - 50.0 * MIN),
            )],
        );
        assert!(!clamp(&e).adjusted);
    }

    #[test]
    fn keeps_an_open_null_ended_segment_open_clamping_a_future_start() {
        let e = entry(
            Some(NOW + 30.0 * MIN),
            None,
            vec![work("s1", SegmentKind::Work, NOW + 30.0 * MIN, None)],
        );
        let r = clamp(&e);
        let ceiling = NOW + DEFAULT_CLOCK_SKEW_MS;
        assert_eq!(r.entry.segments[0].started_at, ceiling);
        assert_eq!(r.entry.segments[0].ended_at, None);
        assert!(r.adjusted);
    }

    #[test]
    fn drops_a_segment_that_becomes_zero_length_after_clamping() {
        // Both start and end are far in the future -> both clamp to ceiling -> zero span.
        let e = entry(
            Some(NOW + 30.0 * MIN),
            Some(NOW + 90.0 * MIN),
            vec![work(
                "s1",
                SegmentKind::Work,
                NOW + 30.0 * MIN,
                Some(NOW + 90.0 * MIN),
            )],
        );
        let r = clamp(&e);
        assert_eq!(r.entry.segments.len(), 0);
        assert!(r.notes.iter().any(|n| n.contains("dropped")));
    }

    #[test]
    fn clamps_only_the_offending_segment_in_a_mixed_set() {
        let e = entry(
            Some(NOW - 20.0 * MIN),
            Some(NOW + 60.0 * MIN),
            vec![
                work(
                    "s1",
                    SegmentKind::Work,
                    NOW - 20.0 * MIN,
                    Some(NOW - 15.0 * MIN),
                ), // honest
                work(
                    "s2",
                    SegmentKind::Meeting,
                    NOW - 10.0 * MIN,
                    Some(NOW + 60.0 * MIN),
                ), // future end
            ],
        );
        let r = clamp(&e);
        assert_eq!(r.entry.segments[0], e.segments[0]); // untouched
        assert_eq!(
            r.entry.segments[1].ended_at,
            Some(NOW + DEFAULT_CLOCK_SKEW_MS)
        );
    }

    #[test]
    fn respects_a_custom_skew_of_0_strict_ceiling_now() {
        let e = entry(
            Some(NOW - 5.0 * MIN),
            Some(NOW + 1.0),
            vec![work(
                "s1",
                SegmentKind::Work,
                NOW - 5.0 * MIN,
                Some(NOW + 1.0),
            )],
        );
        let r = clamp_entry_to_server_clock(&e, NOW, Some(0.0));
        assert_eq!(r.entry.segments[0].ended_at, Some(NOW));
        assert!(r.adjusted);
    }

    #[test]
    fn does_not_mutate_the_input_entry() {
        let e = entry(
            Some(NOW - 5.0 * MIN),
            Some(NOW + 60.0 * MIN),
            vec![work(
                "s1",
                SegmentKind::Work,
                NOW - 5.0 * MIN,
                Some(NOW + 60.0 * MIN),
            )],
        );
        let snapshot = e.clone();
        clamp(&e);
        assert_eq!(e, snapshot);
    }
}
