//! 1:1 port of `packages/core/src/todayLedger.test.ts`.
//!
//! One deliberate difference: the TypeScript `server()` helper computes
//! `canonicalHash` as SHA-256 of the payload. The reconciler only ever compares
//! that string for equality with `acknowledgedHash`, so here it is the payload
//! itself (no hashing dependency); every case is unchanged.
#![cfg(test)]
#![allow(
    clippy::float_cmp,
    clippy::float_arithmetic,
    reason = "the ported tests compare the exact doubles the TypeScript tests compare, and write expected values with the same arithmetic"
)]

use timo_core::{
    AgentCloseReason, CanonicalSegmentLike, CanonicalTimerEntryLike, LedgerConflict, LedgerOrigin,
    LedgerSyncState, LocalLedgerEntry, ReconcileInput, Segment, SegmentKind, ServerLedgerEntry,
    TimeEntry, TimeEntrySource, Timestamp, canonical_timer_entry_payload, reconcile_today_ledger,
};

fn entry(id: &str, revision: f64, span: (f64, Option<f64>), source: TimeEntrySource) -> TimeEntry {
    let (start, end) = span;
    TimeEntry {
        id: id.into(),
        client_uuid: format!("client-{id}"),
        user_id: "user-1".into(),
        lark_task_guid: Some(None),
        source,
        revision,
        started_at: start,
        ended_at: end,
        pause_reason: None,
        close_reason: end.map(|_| AgentCloseReason::Agent),
        segments: vec![Segment {
            id: format!("segment-{id}"),
            kind: SegmentKind::Work,
            started_at: start,
            ended_at: end,
        }],
        shape: timo_core::types::EntryShape::default(),
    }
}

fn auto(id: &str, revision: f64, start: f64, end: Option<f64>) -> TimeEntry {
    entry(id, revision, (start, end), TimeEntrySource::Auto)
}

fn server(entry_value: &TimeEntry, effective: Option<&TimeEntry>) -> ServerLedgerEntry {
    let payload = canonical_timer_entry_payload(&CanonicalTimerEntryLike {
        id: entry_value.id.clone(),
        client_uuid: entry_value.client_uuid.clone(),
        lark_task_guid: None,
        source: entry_value.source,
        revision: Some(entry_value.revision),
        started_at: Timestamp::Number(entry_value.started_at),
        ended_at: entry_value.ended_at.map(Timestamp::Number),
        close_reason: entry_value.close_reason.map(|r| r.as_str().to_owned()),
        segments: entry_value
            .segments
            .iter()
            .map(|s| CanonicalSegmentLike {
                id: s.id.clone(),
                kind: s.kind,
                started_at: Timestamp::Number(s.started_at),
                ended_at: s.ended_at.map(Timestamp::Number),
            })
            .collect(),
    })
    .unwrap();
    ServerLedgerEntry {
        entry: effective.unwrap_or(entry_value).clone(),
        canonical_hash: payload.clone(),
        canonical_payload: payload,
    }
}

fn local(entry_value: &TimeEntry, sync_state: LedgerSyncState) -> LocalLedgerEntry {
    LocalLedgerEntry {
        entry: entry_value.clone(),
        sync_state,
        acknowledged_revision: None,
        acknowledged_hash: None,
    }
}

fn input(
    local: Vec<LocalLedgerEntry>,
    server: Vec<ServerLedgerEntry>,
    window: (f64, f64),
    now: f64,
) -> ReconcileInput {
    ReconcileInput {
        local,
        server,
        active_local_entry_id: None,
        window_start: window.0,
        window_end: window.1,
        now,
    }
}

const H: f64 = 60.0 * 60_000.0;

mod reconcile_today_ledger {
    use super::*;

    #[test]
    fn includes_approved_manual_time_without_double_counting_overlaps() {
        let tracked = auto("tracked", 1.0, 0.0, Some(60_000.0));
        let approved_manual = entry(
            "manual",
            0.0,
            (30_000.0, Some(90_000.0)),
            TimeEntrySource::Manual,
        );
        let projection = reconcile_today_ledger(&input(
            vec![local(&tracked, LedgerSyncState::Synced)],
            vec![server(&tracked, None), server(&approved_manual, None)],
            (0.0, 100_000.0),
            100_000.0,
        ))
        .unwrap();

        assert_eq!(projection.worked_ms, 90_000.0);
        let manual = projection
            .entries
            .iter()
            .find(|item| item.entry.id == "manual")
            .unwrap();
        assert_eq!(manual.origin, LedgerOrigin::Server);
        assert!(!manual.pending);
    }

    #[test]
    fn adds_pending_local_time_without_duplicating_server_confirmed_time() {
        let confirmed = auto("confirmed", 2.0, 0.0, Some(4.5 * H));
        let pending = auto("pending", 1.0, 4.5 * H, Some(5.0 * H));
        let projection = reconcile_today_ledger(&input(
            vec![
                local(&confirmed, LedgerSyncState::Synced),
                local(&pending, LedgerSyncState::PendingCreate),
            ],
            vec![server(&confirmed, None)],
            (0.0, 24.0 * H),
            5.0 * H,
        ))
        .unwrap();
        assert_eq!(projection.worked_ms, 5.0 * H);
        assert_eq!(
            projection
                .entries
                .iter()
                .find(|item| item.entry.id == "pending")
                .map(|i| i.pending),
            Some(true)
        );
    }

    #[test]
    fn keeps_the_visible_total_stable_after_the_pending_row_is_acknowledged() {
        let first = auto("confirmed", 2.0, 0.0, Some(4.5 * H));
        let second = auto("pending", 1.0, 4.5 * H, Some(5.0 * H));
        let projection = reconcile_today_ledger(&input(
            vec![
                local(&first, LedgerSyncState::Synced),
                local(&second, LedgerSyncState::Synced),
            ],
            vec![server(&first, None), server(&second, None)],
            (0.0, 24.0 * H),
            5.0 * H,
        ))
        .unwrap();
        assert_eq!(projection.worked_ms, 5.0 * H);
    }

    #[test]
    fn uses_interval_union_when_separate_rows_overlap() {
        let a = auto("a", 1.0, 0.0, Some(60_000.0));
        let b = auto("b", 1.0, 30_000.0, Some(90_000.0));
        let projection = reconcile_today_ledger(&input(
            vec![local(&a, LedgerSyncState::PendingCreate)],
            vec![server(&b, None)],
            (0.0, 100_000.0),
            100_000.0,
        ))
        .unwrap();
        assert_eq!(projection.worked_ms, 90_000.0);
        assert_eq!(projection.conflicts, 2);
    }

    #[test]
    fn is_deterministic_and_does_not_mutate_either_source() {
        let local_entry = auto("same", 2.0, 0.0, Some(60_000.0));
        let server_entry = auto("same", 1.0, 0.0, Some(30_000.0));
        let source = input(
            vec![local(&local_entry, LedgerSyncState::PendingUpdate)],
            vec![server(&server_entry, None)],
            (0.0, 100_000.0),
            100_000.0,
        );
        let before = source.clone();
        assert_eq!(
            reconcile_today_ledger(&source).unwrap(),
            reconcile_today_ledger(&source).unwrap()
        );
        assert_eq!(source, before);
    }

    #[test]
    fn uses_an_effective_capped_view_without_changing_canonical_comparison() {
        let canonical = auto("open", 1.0, 0.0, None);
        let effective = auto("open", 1.0, 0.0, Some(60_000.0));
        let projection = reconcile_today_ledger(&input(
            vec![local(&canonical, LedgerSyncState::Synced)],
            vec![server(&canonical, Some(&effective))],
            (0.0, 100_000.0),
            100_000.0,
        ))
        .unwrap();
        assert_eq!(projection.worked_ms, 60_000.0);
        assert_eq!(
            projection.entries[0].conflicts,
            Vec::<LedgerConflict>::new()
        );
    }

    #[test]
    fn never_lets_an_expired_server_cache_freeze_the_currently_active_local_timer() {
        let active = auto("active", 1.0, 0.0, None);
        let capped = auto("active", 1.0, 0.0, Some(60_000.0));
        let mut source = input(
            vec![local(&active, LedgerSyncState::Synced)],
            vec![server(&active, Some(&capped))],
            (0.0, 200_000.0),
            120_000.0,
        );
        source.active_local_entry_id = Some(Some(active.id.clone()));
        let projection = reconcile_today_ledger(&source).unwrap();
        assert_eq!(projection.worked_ms, 120_000.0);
        assert_eq!(projection.entries[0].origin, LedgerOrigin::Local);
        assert!(!projection.entries[0].pending);
    }

    #[test]
    fn applies_only_a_server_correction_that_was_explicitly_acknowledged() {
        let local_entry = auto("corrected", 2.0, 0.0, Some(80_000.0));
        let corrected = auto("corrected", 2.0, 0.0, Some(60_000.0));
        let server_entry = server(&corrected, None);
        let projection = reconcile_today_ledger(&input(
            vec![LocalLedgerEntry {
                entry: local_entry,
                sync_state: LedgerSyncState::Synced,
                acknowledged_revision: Some(2.0),
                acknowledged_hash: Some(server_entry.canonical_hash.clone()),
            }],
            vec![server_entry],
            (0.0, 100_000.0),
            100_000.0,
        ))
        .unwrap();
        assert_eq!(projection.worked_ms, 60_000.0);
        assert!(
            projection.entries[0]
                .conflicts
                .contains(&LedgerConflict::AcknowledgedServerCorrection)
        );
    }
}
