//! 1:1 port of the `validateEntry (invariant guard)` block of
//! `packages/core/src/segments.test.ts`. `toMatch(/a|b/)` on the joined errors
//! becomes substring checks.
#![cfg(test)]
#![allow(
    clippy::float_cmp,
    clippy::float_arithmetic,
    reason = "the ported tests compare the exact doubles the TypeScript tests compare, and write expected values with the same arithmetic"
)]

use timo_core::{
    CreateArgs, OpenSegmentArgs, Segment, SegmentKind, TimeEntry, close_time_entry,
    create_time_entry, open_segment, validate_entry,
};

const T0: f64 = 1_700_000_000_000.0;
const MIN: f64 = 60_000.0;

fn base_entry() -> TimeEntry {
    create_time_entry(&CreateArgs {
        id: "te_1".into(),
        client_uuid: "uuid_1".into(),
        user_id: "u_1".into(),
        lark_task_guid: None,
        source: None,
        started_at: T0,
        segment_id: "s_1".into(),
    })
}

fn seg(id: &str, started_at: f64, ended_at: Option<f64>) -> Segment {
    Segment {
        id: id.into(),
        kind: SegmentKind::Work,
        started_at,
        ended_at,
    }
}

fn joined(e: &TimeEntry) -> String {
    validate_entry(e).join(";")
}

/// A stand-in for `toMatch(/first.*second.*third/)`: the pieces in order.
fn in_order(haystack: &str, pieces: &[&str]) -> bool {
    let mut rest = haystack;
    for piece in pieces {
        match rest.split_once(piece) {
            Some((_, after)) => rest = after,
            None => return false,
        }
    }
    true
}

mod validate_entry_invariant_guard {
    use super::*;

    #[test]
    fn flags_two_open_segments() {
        let mut e = base_entry();
        e.segments.push(seg("s_bad", T0 + MIN, None));
        let text = joined(&e);
        assert!(text.contains("open segments") || text.contains("not last"));
    }

    #[test]
    fn flags_overlapping_segments() {
        let e = TimeEntry {
            segments: vec![
                seg("a", T0, Some(T0 + 10.0 * MIN)),
                seg("b", T0 + 5.0 * MIN, None),
            ],
            ..base_entry()
        };
        assert!(joined(&e).contains("overlaps"));
    }

    #[test]
    fn flags_ended_at_before_started_at() {
        let e = TimeEntry {
            ended_at: Some(T0),
            segments: vec![seg("a", T0 + 10.0 * MIN, Some(T0))],
            ..base_entry()
        };
        assert!(in_order(&joined(&e), &["endedAt", "<", "startedAt"]));
    }

    #[test]
    fn flags_entry_started_at_mismatch_with_first_segment() {
        let mut e = base_entry();
        e.started_at = T0 - MIN;
        assert!(joined(&e).contains("entry.startedAt"));
    }

    #[test]
    fn flags_a_closed_entry_that_still_has_an_open_segment() {
        let mut e = base_entry();
        e.ended_at = Some(T0 + 10.0 * MIN); // closed entry but segment still open
        assert!(joined(&e).contains("closed but has an open segment"));
    }

    #[test]
    fn flags_duplicate_segment_ids() {
        let e = TimeEntry {
            ended_at: Some(T0 + 20.0 * MIN),
            segments: vec![
                seg("dup", T0, Some(T0 + 10.0 * MIN)),
                seg("dup", T0 + 10.0 * MIN, Some(T0 + 20.0 * MIN)),
            ],
            ..base_entry()
        };
        assert!(joined(&e).contains("duplicate segment id"));
    }

    #[test]
    fn accepts_a_well_formed_multi_segment_entry() {
        let mut e = base_entry();
        e = open_segment(
            &e,
            &OpenSegmentArgs {
                kind: SegmentKind::Meeting,
                at: T0 + 10.0 * MIN,
                segment_id: "s2".into(),
            },
        )
        .unwrap();
        e = close_time_entry(&e, T0 + 25.0 * MIN).unwrap();
        assert_eq!(validate_entry(&e), Vec::<String>::new());
    }
}
