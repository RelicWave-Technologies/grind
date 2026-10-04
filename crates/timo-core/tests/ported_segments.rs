//! 1:1 port of `packages/core/src/segments.test.ts` (all but `validateEntry`,
//! which is in `ported_segments_validate.rs`). `describe` is a module, `it` a
//! test with the same name in `snake_case`.
#![cfg(test)]
#![allow(
    clippy::float_cmp,
    clippy::float_arithmetic,
    reason = "the ported tests compare the exact doubles the TypeScript tests compare, and write expected values with the same arithmetic"
)]

use timo_core::{
    CoreError, CreateArgs, IdleDiscardArgs, OpenSegmentArgs, SegmentKind, TimeEntry,
    TimeEntrySource, apply_idle_discard, close_open_segment, close_time_entry, create_time_entry,
    get_open_segment, open_segment, recover_stale_entry, total_idle_trimmed_ms, total_worked_ms,
    validate_entry,
};

// Fixed epoch anchors (ms) for readable assertions.
const T0: f64 = 1_700_000_000_000.0;
const MIN: f64 = 60_000.0;

fn base_entry(started_at: f64) -> TimeEntry {
    create_time_entry(&CreateArgs {
        id: "te_1".into(),
        client_uuid: "uuid_1".into(),
        user_id: "u_1".into(),
        lark_task_guid: None,
        source: None,
        started_at,
        segment_id: "s_1".into(),
    })
}

#[allow(
    clippy::needless_pass_by_value,
    reason = "reads like the TypeScript `expect(() => ...).toThrow(SegmentError)`"
)]
fn is_segment_error(r: Result<TimeEntry, CoreError>) -> bool {
    matches!(r, Err(CoreError::Segment(_)))
}

fn kinds(e: &TimeEntry) -> Vec<SegmentKind> {
    e.segments.iter().map(|s| s.kind).collect()
}

/// `toMatchObject({ startedAt, endedAt })` on segment `i`.
fn assert_span(e: &TimeEntry, i: usize, started_at: f64, ended_at: Option<f64>) {
    assert_eq!(e.segments[i].started_at, started_at);
    assert_eq!(e.segments[i].ended_at, ended_at);
}

mod create_time_entry {
    use super::*;

    #[test]
    fn creates_a_running_entry_with_one_open_work_segment() {
        let e = base_entry(T0);
        assert_eq!(e.ended_at, None);
        assert_eq!(e.segments.len(), 1);
        assert_eq!(e.segments[0].id, "s_1");
        assert_eq!(e.segments[0].kind, SegmentKind::Work);
        assert_span(&e, 0, T0, None);
        assert_eq!(e.source, TimeEntrySource::Auto);
        assert_eq!(e.lark_task_guid, Some(None));
        assert_eq!(validate_entry(&e), Vec::<String>::new());
    }

    #[test]
    fn honors_explicit_source_and_lark_task_attribution() {
        let e = create_time_entry(&CreateArgs {
            id: "te".into(),
            client_uuid: "u".into(),
            user_id: "u1".into(),
            lark_task_guid: Some("guid_xyz".into()),
            source: Some(TimeEntrySource::Manual),
            started_at: T0,
            segment_id: "s".into(),
        });
        assert_eq!(e.source, TimeEntrySource::Manual);
        assert_eq!(e.lark_task_guid, Some(Some("guid_xyz".into())));
    }
}

mod close_open_segment {
    use super::*;

    #[test]
    fn closes_the_open_segment() {
        let e = close_open_segment(&base_entry(T0), T0 + 10.0 * MIN).unwrap();
        assert_eq!(e.segments[0].ended_at, Some(T0 + 10.0 * MIN));
        assert_eq!(get_open_segment(&e), None);
        assert_eq!(validate_entry(&e), Vec::<String>::new());
    }

    #[test]
    fn is_a_no_op_idempotent_when_nothing_is_open() {
        let closed = close_open_segment(&base_entry(T0), T0 + MIN).unwrap();
        let again = close_open_segment(&closed, T0 + 5.0 * MIN).unwrap();
        assert_eq!(again, closed);
    }

    #[test]
    fn throws_when_closing_before_the_segment_start() {
        assert!(is_segment_error(close_open_segment(
            &base_entry(T0),
            T0 - 1.0
        )));
    }

    #[test]
    fn does_not_mutate_the_input() {
        let e = base_entry(T0);
        let snapshot = e.clone();
        close_open_segment(&e, T0 + MIN).unwrap();
        assert_eq!(e, snapshot);
    }
}

fn open_args(kind: SegmentKind, at: f64, segment_id: &str) -> OpenSegmentArgs {
    OpenSegmentArgs {
        kind,
        at,
        segment_id: segment_id.into(),
    }
}

mod open_segment_transitions {
    use super::*;

    #[test]
    fn closes_the_current_segment_and_opens_a_new_one_of_the_given_kind() {
        let mut e = base_entry(T0);
        e = open_segment(&e, &open_args(SegmentKind::Meeting, T0 + 5.0 * MIN, "s_2")).unwrap();
        assert_eq!(e.segments.len(), 2);
        assert_eq!(e.segments[0].kind, SegmentKind::Work);
        assert_eq!(e.segments[0].ended_at, Some(T0 + 5.0 * MIN));
        assert_eq!(e.segments[1].kind, SegmentKind::Meeting);
        assert_span(&e, 1, T0 + 5.0 * MIN, None);
        assert_eq!(validate_entry(&e), Vec::<String>::new());
    }

    #[test]
    fn supports_meeting_to_work_back_transition() {
        let mut e = base_entry(T0);
        e = open_segment(&e, &open_args(SegmentKind::Meeting, T0 + 5.0 * MIN, "s_2")).unwrap();
        e = open_segment(&e, &open_args(SegmentKind::Work, T0 + 20.0 * MIN, "s_3")).unwrap();
        assert_eq!(
            kinds(&e),
            [SegmentKind::Work, SegmentKind::Meeting, SegmentKind::Work]
        );
        assert_eq!(validate_entry(&e), Vec::<String>::new());
    }

    #[test]
    fn throws_when_opening_on_a_closed_entry() {
        let e = close_time_entry(&base_entry(T0), T0 + MIN).unwrap();
        assert!(is_segment_error(open_segment(
            &e,
            &open_args(SegmentKind::Work, T0 + 2.0 * MIN, "x")
        )));
    }
}

mod close_time_entry {
    use super::*;

    #[test]
    fn closes_the_open_segment_and_stamps_ended_at() {
        let e = close_time_entry(&base_entry(T0), T0 + 30.0 * MIN).unwrap();
        assert_eq!(e.ended_at, Some(T0 + 30.0 * MIN));
        assert_eq!(get_open_segment(&e), None);
        assert_eq!(validate_entry(&e), Vec::<String>::new());
    }

    #[test]
    fn is_idempotent() {
        let once = close_time_entry(&base_entry(T0), T0 + 30.0 * MIN).unwrap();
        let twice = close_time_entry(&once, T0 + 99.0 * MIN).unwrap();
        assert_eq!(twice, once);
    }
}

mod total_worked_ms {
    use super::*;

    #[test]
    fn counts_a_single_closed_work_segment() {
        let e = close_time_entry(&base_entry(T0), T0 + 10.0 * MIN).unwrap();
        assert_eq!(total_worked_ms(&e, None).unwrap(), 10.0 * MIN);
    }

    #[test]
    fn counts_the_open_segment_up_to_now() {
        assert_eq!(
            total_worked_ms(&base_entry(T0), Some(T0 + 7.0 * MIN)).unwrap(),
            7.0 * MIN
        );
    }

    #[test]
    fn throws_if_open_segment_and_now_omitted() {
        assert!(matches!(
            total_worked_ms(&base_entry(T0), None),
            Err(CoreError::Segment(_))
        ));
    }

    #[test]
    fn counts_work_plus_meeting_but_not_idle_trimmed() {
        let mut e = base_entry(T0); // WORK from T0
        e = open_segment(&e, &open_args(SegmentKind::Meeting, T0 + 10.0 * MIN, "s_2")).unwrap(); // WORK 10m
        e = close_time_entry(&e, T0 + 25.0 * MIN).unwrap(); // MEETING 15m
        assert_eq!(total_worked_ms(&e, None).unwrap(), 25.0 * MIN);
    }
}

fn idle_args(idle_started_at: f64, resume_at: f64, idle: &str, work: &str) -> IdleDiscardArgs {
    IdleDiscardArgs {
        idle_started_at,
        resume_at,
        idle_segment_id: idle.into(),
        work_segment_id: work.into(),
    }
}

mod apply_idle_discard {
    use super::*;

    #[test]
    fn trims_the_idle_gap_and_resumes_a_fresh_work_segment() {
        // WORK from T0; user active until T0+8m, idle detected, resumes at T0+15m.
        let mut e = base_entry(T0);
        e = apply_idle_discard(
            &e,
            &idle_args(T0 + 8.0 * MIN, T0 + 15.0 * MIN, "s_idle", "s_resume"),
        )
        .unwrap();
        assert_eq!(
            kinds(&e),
            [
                SegmentKind::Work,
                SegmentKind::IdleTrimmed,
                SegmentKind::Work
            ]
        );
        assert_span(&e, 0, T0, Some(T0 + 8.0 * MIN));
        assert_span(&e, 1, T0 + 8.0 * MIN, Some(T0 + 15.0 * MIN));
        assert_span(&e, 2, T0 + 15.0 * MIN, None);
        assert_eq!(validate_entry(&e), Vec::<String>::new());

        // The 7-minute idle gap is NOT counted; only the 8m worked so far + open.
        assert_eq!(
            total_worked_ms(&e, Some(T0 + 20.0 * MIN)).unwrap(),
            8.0 * MIN + 5.0 * MIN
        );
        assert_eq!(total_idle_trimmed_ms(&e), 7.0 * MIN);
    }

    #[test]
    fn drops_the_whole_work_segment_when_it_was_entirely_idle() {
        // idleStartedAt before/at the open segment start => whole segment is idle.
        let mut e = base_entry(T0 + 10.0 * MIN);
        e = apply_idle_discard(
            &e,
            &idle_args(T0 + 5.0 * MIN, T0 + 30.0 * MIN, "s_idle", "s_resume"),
        )
        .unwrap();
        assert_eq!(kinds(&e), [SegmentKind::IdleTrimmed, SegmentKind::Work]);
        assert_span(&e, 0, T0 + 10.0 * MIN, Some(T0 + 30.0 * MIN));
        assert_span(&e, 1, T0 + 30.0 * MIN, None);
        assert_eq!(validate_entry(&e), Vec::<String>::new());
        assert_eq!(
            total_worked_ms(&e, Some(T0 + 35.0 * MIN)).unwrap(),
            5.0 * MIN
        ); // only post-resume work
    }

    #[test]
    fn handles_idle_started_at_exactly_at_segment_start() {
        let mut e = base_entry(T0);
        e = apply_idle_discard(&e, &idle_args(T0, T0 + 12.0 * MIN, "i", "w")).unwrap();
        assert_eq!(kinds(&e), [SegmentKind::IdleTrimmed, SegmentKind::Work]);
        assert_eq!(validate_entry(&e), Vec::<String>::new());
    }

    #[test]
    fn throws_when_resume_at_precedes_idle_started_at() {
        let r = apply_idle_discard(
            &base_entry(T0),
            &idle_args(T0 + 10.0 * MIN, T0 + 5.0 * MIN, "i", "w"),
        );
        assert!(is_segment_error(r));
    }

    #[test]
    fn throws_when_there_is_no_open_segment() {
        let closed = close_time_entry(&base_entry(T0), T0 + MIN).unwrap();
        assert!(is_segment_error(apply_idle_discard(
            &closed,
            &idle_args(T0, T0 + MIN, "i", "w")
        )));
    }

    #[test]
    fn supports_repeated_idle_resume_cycles_and_stays_valid() {
        let mut e = base_entry(T0);
        e = apply_idle_discard(&e, &idle_args(T0 + 5.0 * MIN, T0 + 10.0 * MIN, "i1", "w1"))
            .unwrap();
        e = apply_idle_discard(&e, &idle_args(T0 + 18.0 * MIN, T0 + 25.0 * MIN, "i2", "w2"))
            .unwrap();
        assert_eq!(validate_entry(&e), Vec::<String>::new());
        // worked: [0,5) + [10,18) + [25, now=30) = 5 + 8 + 5 = 18m; idle: 5 + 7 = 12m
        assert_eq!(
            total_worked_ms(&e, Some(T0 + 30.0 * MIN)).unwrap(),
            18.0 * MIN
        );
        assert_eq!(total_idle_trimmed_ms(&e), 12.0 * MIN);
    }
}

mod recover_stale_entry_crash_recovery {
    use super::*;

    #[test]
    fn closes_an_open_entry_at_the_last_known_active_time() {
        let e = recover_stale_entry(&base_entry(T0), T0 + 12.0 * MIN).unwrap();
        assert_eq!(e.ended_at, Some(T0 + 12.0 * MIN));
        assert_eq!(get_open_segment(&e), None);
        assert_eq!(total_worked_ms(&e, None).unwrap(), 12.0 * MIN);
        assert_eq!(validate_entry(&e), Vec::<String>::new());
    }

    #[test]
    fn never_produces_a_negative_segment_when_last_known_active_precedes_start() {
        let e = recover_stale_entry(&base_entry(T0 + 10.0 * MIN), T0).unwrap(); // lastActive before start
        assert_eq!(e.ended_at, Some(T0 + 10.0 * MIN)); // clamped to segment start => zero-length
        assert_eq!(total_worked_ms(&e, None).unwrap(), 0.0);
        assert_eq!(validate_entry(&e), Vec::<String>::new());
    }

    #[test]
    fn is_a_no_op_on_an_already_closed_entry() {
        let closed = close_time_entry(&base_entry(T0), T0 + MIN).unwrap();
        assert_eq!(
            recover_stale_entry(&closed, T0 + 99.0 * MIN).unwrap(),
            closed
        );
    }
}
