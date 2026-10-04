//! Pure reconciliation of the local timer journal with the server's view.
//!
//! It never mutates either source and never treats a server fetch as permission
//! to delete the local journal.
//!
//! Port of `packages/core/src/todayLedger.ts`. The interval maths (counted
//! intervals, overlap detection, union duration) is in
//! [`crate::today_ledger_intervals`].

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::error::CoreError;
use crate::js::collate::collator;
use crate::js::number::sort_cmp;
use crate::js::number::strict_eq;
use crate::timer_ledger::{
    CanonicalSegmentLike, CanonicalTimerEntryLike, Timestamp, canonical_timer_entry_payload,
};
use crate::today_ledger_intervals::{counted_intervals, overlapping_entry_ids, union_duration};
use crate::types::{TimeEntry, present_or_null};

/// Port of `packages/core/src/todayLedger.ts::LedgerSyncState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LedgerSyncState {
    PendingCreate,
    PendingUpdate,
    Synced,
}

/// Port of `packages/core/src/todayLedger.ts::LedgerConflict`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LedgerConflict {
    RevisionPayloadConflict,
    AcknowledgedServerCorrection,
    ServerNewer,
    ServerMissing,
    Overlap,
}

/// Port of `packages/core/src/todayLedger.ts::LocalLedgerEntry`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLedgerEntry {
    pub entry: TimeEntry,
    pub sync_state: LedgerSyncState,
    pub acknowledged_revision: Option<f64>,
    pub acknowledged_hash: Option<String>,
}

/// Port of `packages/core/src/todayLedger.ts::ServerLedgerEntry`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerLedgerEntry {
    /// Effective entry used by UI/totals; canonical hash remains unmodified.
    pub entry: TimeEntry,
    pub canonical_payload: String,
    pub canonical_hash: String,
}

/// The `'LOCAL' | 'SERVER'` of `LedgerProjectionEntry.origin`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LedgerOrigin {
    Local,
    Server,
}

/// Port of `packages/core/src/todayLedger.ts::LedgerProjectionEntry`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LedgerProjectionEntry {
    pub entry: TimeEntry,
    pub origin: LedgerOrigin,
    pub pending: bool,
    pub conflicts: Vec<LedgerConflict>,
}

/// Port of `packages/core/src/todayLedger.ts::TodayLedgerProjection`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodayLedgerProjection {
    pub entries: Vec<LedgerProjectionEntry>,
    pub worked_ms: f64,
    pub conflicts: usize,
}

/// Port of the inline `input` type of `reconcileTodayLedger`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileInput {
    pub local: Vec<LocalLedgerEntry>,
    pub server: Vec<ServerLedgerEntry>,
    /// `activeLocalEntryId?: string | null`: absent and `null` behave the same.
    #[serde(default, deserialize_with = "present_or_null")]
    pub active_local_entry_id: Option<Option<String>>,
    pub window_start: f64,
    pub window_end: f64,
    pub now: f64,
}

/// Port of `packages/core/src/todayLedger.ts::canonical`.
fn canonical(entry: &TimeEntry) -> Result<String, CoreError> {
    canonical_timer_entry_payload(&CanonicalTimerEntryLike {
        id: entry.id.clone(),
        client_uuid: entry.client_uuid.clone(),
        lark_task_guid: entry.lark_task_guid.clone().flatten(),
        source: entry.source,
        revision: Some(entry.revision),
        started_at: Timestamp::Number(entry.started_at),
        ended_at: entry.ended_at.map(Timestamp::Number),
        close_reason: entry.close_reason.map(|r| r.as_str().to_owned()),
        segments: entry
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
}

/// The server entry indexed by id and by client uuid. Like a JS `Map`, a later
/// duplicate key replaces the earlier one.
struct ServerIndex<'a> {
    by_id: HashMap<&'a str, &'a ServerLedgerEntry>,
    by_client_uuid: HashMap<&'a str, &'a ServerLedgerEntry>,
}

impl<'a> ServerIndex<'a> {
    fn new(server: &'a [ServerLedgerEntry]) -> Self {
        Self {
            by_id: server.iter().map(|s| (s.entry.id.as_str(), s)).collect(),
            by_client_uuid: server
                .iter()
                .map(|s| (s.entry.client_uuid.as_str(), s))
                .collect(),
        }
    }

    /// Port of `packages/core/src/todayLedger.ts::matchingServer`.
    fn matching(&self, local: &TimeEntry) -> Option<&'a ServerLedgerEntry> {
        self.by_id
            .get(local.id.as_str())
            .or_else(|| self.by_client_uuid.get(local.client_uuid.as_str()))
            .copied()
    }
}

/// Pure reconciliation. It never mutates either source and never treats a
/// server fetch as permission to delete the local journal.
///
/// Port of `packages/core/src/todayLedger.ts::reconcileTodayLedger`.
pub fn reconcile_today_ledger(input: &ReconcileInput) -> Result<TodayLedgerProjection, CoreError> {
    let index = ServerIndex::new(&input.server);
    let mut consumed_server_ids: HashSet<&str> = HashSet::new();
    let mut projected = Vec::new();
    for local in &input.local {
        let server = index.matching(&local.entry);
        if let Some(server) = server {
            consumed_server_ids.insert(server.entry.id.as_str());
        }
        projected.push(project_local(local, server, input)?);
    }
    for server in &input.server {
        if !consumed_server_ids.contains(server.entry.id.as_str()) {
            projected.push(LedgerProjectionEntry {
                entry: server.entry.clone(),
                origin: LedgerOrigin::Server,
                pending: false,
                conflicts: Vec::new(),
            });
        }
    }
    let collator = collator()?;
    projected.sort_by(|a, b| {
        sort_cmp(b.entry.started_at, a.entry.started_at)
            .then_with(|| collator.compare(&a.entry.id, &b.entry.id))
    });
    Ok(finish(projected, input))
}

/// Mark overlaps and total the union: the tail of `reconcileTodayLedger`.
fn finish(
    mut projected: Vec<LedgerProjectionEntry>,
    input: &ReconcileInput,
) -> TodayLedgerProjection {
    let intervals = counted_intervals(&projected, input.window_start, input.window_end, input.now);
    let overlap_ids: HashSet<String> = overlapping_entry_ids(&intervals)
        .into_iter()
        .map(str::to_owned)
        .collect();
    let worked_ms = union_duration(&intervals);
    if !overlap_ids.is_empty() {
        for item in projected
            .iter_mut()
            .filter(|c| overlap_ids.contains(&c.entry.id))
        {
            if item.conflicts.is_empty() {
                item.conflicts = vec![LedgerConflict::Overlap];
            } else if !item.conflicts.contains(&LedgerConflict::Overlap) {
                item.conflicts.push(LedgerConflict::Overlap);
            }
        }
    }
    let conflicts = projected.iter().filter(|e| !e.conflicts.is_empty()).count();
    TodayLedgerProjection {
        entries: projected,
        worked_ms,
        conflicts,
    }
}

/// The body of the `for (const local of input.local)` loop.
fn project_local(
    local: &LocalLedgerEntry,
    server: Option<&ServerLedgerEntry>,
    input: &ReconcileInput,
) -> Result<LedgerProjectionEntry, CoreError> {
    let pending = local.sync_state != LedgerSyncState::Synced;
    let Some(server) = server else {
        return Ok(LedgerProjectionEntry {
            entry: local.entry.clone(),
            origin: LedgerOrigin::Local,
            pending,
            conflicts: if pending {
                Vec::new()
            } else {
                vec![LedgerConflict::ServerMissing]
            },
        });
    };
    let same_payload = canonical(&local.entry)? == server.canonical_payload;
    if strict_eq(local.entry.revision, server.entry.revision) && same_payload {
        let locally_active = input
            .active_local_entry_id
            .as_ref()
            .and_then(Option::as_deref)
            == Some(local.entry.id.as_str());
        let (entry, origin) = if locally_active {
            (&local.entry, LedgerOrigin::Local)
        } else {
            (&server.entry, LedgerOrigin::Server)
        };
        return Ok(projection(entry, origin, pending, None));
    }
    Ok(diverged(local, server, pending))
}

/// The local and server rows disagree (revision or payload): decide which one
/// the projection shows. Order matters and is the TypeScript order.
fn diverged(
    local: &LocalLedgerEntry,
    server: &ServerLedgerEntry,
    pending: bool,
) -> LedgerProjectionEntry {
    let acknowledged_correction = local
        .acknowledged_revision
        .is_some_and(|r| strict_eq(r, server.entry.revision))
        && local.acknowledged_hash.as_deref() == Some(server.canonical_hash.as_str());
    let from_server =
        |conflict| projection(&server.entry, LedgerOrigin::Server, false, Some(conflict));
    if acknowledged_correction {
        from_server(LedgerConflict::AcknowledgedServerCorrection)
    } else if local.entry.revision > server.entry.revision {
        projection(&local.entry, LedgerOrigin::Local, true, None)
    } else if strict_eq(local.entry.revision, server.entry.revision) {
        projection(
            &local.entry,
            LedgerOrigin::Local,
            pending,
            Some(LedgerConflict::RevisionPayloadConflict),
        )
    } else {
        from_server(LedgerConflict::ServerNewer)
    }
}

fn projection(
    entry: &TimeEntry,
    origin: LedgerOrigin,
    pending: bool,
    conflict: Option<LedgerConflict>,
) -> LedgerProjectionEntry {
    LedgerProjectionEntry {
        entry: entry.clone(),
        origin,
        pending,
        conflicts: conflict.into_iter().collect(),
    }
}
