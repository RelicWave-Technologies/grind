//! 1:1 port of `packages/core/src/timerLedger.test.ts`.
#![cfg(test)]
#![allow(
    clippy::float_cmp,
    clippy::float_arithmetic,
    reason = "the ported tests compare the exact doubles the TypeScript tests compare, and write expected values with the same arithmetic"
)]

use timo_core::{
    CanonicalSegmentLike, CanonicalTimerEntryLike, SegmentKind, TimeEntrySource, Timestamp,
    canonical_timer_entry_payload,
};

mod canonical_timer_entry_payload {
    use super::*;

    fn like(
        guid: Option<String>,
        started_at: Timestamp,
        ended_at: Timestamp,
        segments: Vec<CanonicalSegmentLike>,
    ) -> CanonicalTimerEntryLike {
        CanonicalTimerEntryLike {
            id: "entry".into(),
            client_uuid: "client".into(),
            lark_task_guid: guid,
            source: TimeEntrySource::Auto,
            revision: Some(2.0),
            started_at,
            ended_at: Some(ended_at),
            close_reason: Some("AGENT".into()),
            segments,
        }
    }

    fn segment(
        id: &str,
        kind: SegmentKind,
        started_at: Timestamp,
        ended_at: Timestamp,
    ) -> CanonicalSegmentLike {
        CanonicalSegmentLike {
            id: id.into(),
            kind,
            started_at,
            ended_at: Some(ended_at),
        }
    }

    #[test]
    fn normalizes_timestamp_representations_and_segment_order() {
        use Timestamp::{Number, Text};
        let first = canonical_timer_entry_payload(&like(
            None,
            Number(1_000.0),
            Number(3_000.0),
            vec![
                segment("b", SegmentKind::Meeting, Number(2_000.0), Number(3_000.0)),
                segment("a", SegmentKind::Work, Number(1_000.0), Number(2_000.0)),
            ],
        ))
        .unwrap();
        // `new Date(1_000)` and `new Date(n).toISOString()` arrive as ISO text:
        // a Date serializes to its ISO string.
        let second = canonical_timer_entry_payload(&like(
            None,
            Text("1970-01-01T00:00:01.000Z".into()),
            Text("1970-01-01T00:00:03.000Z".into()),
            vec![
                segment(
                    "a",
                    SegmentKind::Work,
                    Text("1970-01-01T00:00:01.000Z".into()),
                    Text("1970-01-01T00:00:02.000Z".into()),
                ),
                segment(
                    "b",
                    SegmentKind::Meeting,
                    Text("1970-01-01T00:00:02.000Z".into()),
                    Number(3_000.0),
                ),
            ],
        ))
        .unwrap();
        assert_eq!(second, first);
    }
}
