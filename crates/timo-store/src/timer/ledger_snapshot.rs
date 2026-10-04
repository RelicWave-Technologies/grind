//! Validating a day snapshot and turning it into rows.
//!
//! Port of the validation half of `SqliteTodayLedgerStore.replaceSnapshot` and of
//! `canonicalTimerEntryPayload(canonical)` as `list` calls it, in
//! `legacy/agent/src/main/services/timer/todayLedgerStore.ts`.

use rusqlite::{Connection, named_params};
use timo_core::js::ser::to_string;
use timo_core::timer::TimerError;
use timo_core::timer::dto::{TimeEntryDto, TodayLedgerResponse};
use timo_core::timer::types::{DayWindow, TimerOwner};
use timo_core::timer_ledger::{
    CanonicalSegmentLike, CanonicalTimerEntryLike, Timestamp, canonical_timer_entry_payload,
};
use timo_core::types::TimeEntrySource;

use super::db::db_err;
use super::effective::{fallback_effective_entry, validate_effective_entries};

fn store_err(error: &timo_core::js::ser::SerError) -> TimerError {
    TimerError::Store(error.to_string())
}

/// `canonicalTimerEntryPayload(dto)`: a DTO's ISO strings are the timestamps.
pub(super) fn canonical_payload(entry: &TimeEntryDto) -> Result<String, TimerError> {
    Ok(canonical_timer_entry_payload(&CanonicalTimerEntryLike {
        id: entry.id.clone(),
        client_uuid: entry.client_uuid.clone(),
        lark_task_guid: entry.lark_task_guid.clone(),
        source: entry.source,
        revision: entry.revision,
        started_at: Timestamp::Text(entry.started_at.clone()),
        ended_at: entry.ended_at.clone().map(Timestamp::Text),
        close_reason: entry
            .close_reason
            .map(|r| to_string(&r).map(|q| q.trim_matches('"').to_owned()))
            .transpose()
            .map_err(|e| store_err(&e))?,
        segments: entry
            .segments
            .iter()
            .map(|s| CanonicalSegmentLike {
                id: s.id.clone(),
                kind: s.kind,
                started_at: Timestamp::Text(s.started_at.clone()),
                ended_at: s.ended_at.clone().map(Timestamp::Text),
            })
            .collect(),
    })?)
}

/// One entry ready to insert: the DTO, its JSON and its effective entry's JSON.
pub(super) struct Row<'a> {
    pub(super) entry: &'a TimeEntryDto,
    pub(super) json: String,
    pub(super) effective_json: String,
}

/// The arguments of `replaceSnapshot`.
#[derive(Debug, Clone, Copy)]
pub struct SnapshotAt<'a> {
    pub owner: &'a TimerOwner,
    pub window: DayWindow,
    pub response: &'a TodayLedgerResponse,
    /// `Date.now()`: informational only.
    pub fetched_at: f64,
}

/// The validation half of `replaceSnapshot`: entries parse, belong to the owner,
/// and every AUTO entry has one matching effective entry.
pub(super) fn validated_rows<'a>(
    owner: &TimerOwner,
    response: &'a TodayLedgerResponse,
) -> Result<Vec<Row<'a>>, TimerError> {
    let manual = response
        .approved_manual_entries
        .as_deref()
        .unwrap_or_default();
    for entry in response.entries.iter().chain(manual) {
        entry
            .validate()
            .map_err(|e| TimerError::Store(e.to_string()))?;
    }
    if response
        .entries
        .iter()
        .any(|e| e.user_id != owner.user_id || e.source != TimeEntrySource::Auto)
    {
        return Err(TimerError::Store("today_ledger_owner_mismatch".to_owned()));
    }
    if manual.iter().any(|e| {
        e.user_id != owner.user_id
            || e.source != TimeEntrySource::Manual
            || e.ended_at.is_none()
            || e.segments.iter().any(|s| s.ended_at.is_none())
    }) {
        return Err(TimerError::Store(
            "today_ledger_manual_entry_invalid".to_owned(),
        ));
    }
    let by_entry = validate_effective_entries(&response.entries, &response.effective_entries)?;
    let mut rows = Vec::new();
    for entry in response.entries.iter().chain(manual) {
        let effective = by_entry
            .get(entry.id.as_str())
            .map_or_else(|| fallback_effective_entry(entry), |e| (*e).clone());
        rows.push(Row {
            entry,
            json: to_string(entry).map_err(|e| store_err(&e))?,
            effective_json: to_string(&effective).map_err(|e| store_err(&e))?,
        });
    }
    Ok(rows)
}

pub(super) fn insert_row(
    tx: &Connection,
    snapshot: &SnapshotAt<'_>,
    row: &Row<'_>,
) -> Result<(), TimerError> {
    tx.execute(
        "INSERT INTO server_entry_cache (
           owner_user_id, owner_workspace_id, day_start, day_end,
           entry_id, client_uuid, revision, fetched_at, canonical_json, effective_json
         ) VALUES (
           @ownerUserId, @ownerWorkspaceId, @dayStart, @dayEnd,
           @entryId, @clientUuid, @revision, @fetchedAt, @json, @effectiveJson
         )",
        named_params! {
            "@ownerUserId": snapshot.owner.user_id,
            "@ownerWorkspaceId": snapshot.owner.workspace_id,
            "@dayStart": snapshot.window.start,
            "@dayEnd": snapshot.window.end,
            "@entryId": row.entry.id,
            "@clientUuid": row.entry.client_uuid,
            "@revision": row.entry.revision.unwrap_or(0.0),
            "@fetchedAt": snapshot.fetched_at,
            "@json": row.json,
            "@effectiveJson": row.effective_json,
        },
    )
    .map_err(db_err)?;
    Ok(())
}
