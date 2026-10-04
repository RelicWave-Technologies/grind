//! Reading what the TypeScript wrote: entries and the meta JSON.
//!
//! Port of `parseEntry`, `asSyncState`, `asFiniteNumber`, `asExitIntent`,
//! `asRecoveryNotice` and `asAwayState` of `sqliteStore.ts`. Legacy rows are
//! normalised exactly as there: a missing or odd `revision` is 0, an unknown
//! `closeReason`/`pauseReason` is `null`.

use serde::Deserialize;
use serde_json::Value;
use timo_core::timer::TimerError;
use timo_core::timer::types::{
    EntrySyncState, ReadRecoveryNotice, TimerAwayReason, TimerAwayState, TimerExitIntent,
    TimerExitReason, TimerRecoveryNotice, TimerRecoveryReason,
};
use timo_core::types::{
    AgentCloseReason, EntryShape, JsonValue, PARSE_ADDS, Segment, TimeEntry, TimeEntryPauseReason,
    TimeEntrySource, present_or_null,
};

use super::js_number::is_non_negative_integer;

/// A stored entry before normalisation: the three fields `parseEntry` repairs
/// are read loosely.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(
    clippy::option_option,
    reason = "`larkTaskGuid` is absent, null or a string, as in core's TimeEntry"
)]
struct RawEntry {
    id: String,
    client_uuid: String,
    user_id: String,
    #[serde(default, deserialize_with = "present_or_null")]
    lark_task_guid: Option<Option<String>>,
    source: TimeEntrySource,
    #[serde(default)]
    revision: Option<Value>,
    started_at: f64,
    ended_at: Option<f64>,
    #[serde(default)]
    pause_reason: Option<Value>,
    #[serde(default)]
    close_reason: Option<Value>,
    segments: Vec<Segment>,
}

/// Port of `sqliteStore.ts::parseEntry`: `{...raw, revision, closeReason, pauseReason}`, so
/// the row's key order and unknown keys are kept and a missing one of the three is appended.
pub fn parse_entry(json: &str) -> Result<TimeEntry, TimerError> {
    let store = |e: serde_json::Error| TimerError::Store(e.to_string());
    let raw: RawEntry = serde_json::from_str(json).map_err(store)?;
    let JsonValue::Object(doc) = serde_json::from_str(json).map_err(store)? else {
        return Err(TimerError::Store(
            "a stored entry is a JSON object".to_owned(),
        ));
    };
    let revision = raw
        .revision
        .as_ref()
        .and_then(Value::as_f64)
        .filter(|n| is_non_negative_integer(*n))
        .unwrap_or(0.0);
    let close_reason = match raw.close_reason.as_ref().and_then(Value::as_str) {
        Some("AGENT_RECOVERY") => Some(AgentCloseReason::AgentRecovery),
        Some("AGENT") => Some(AgentCloseReason::Agent),
        _ => None,
    };
    let pause_reason = match raw.pause_reason.as_ref().and_then(Value::as_str) {
        Some("IDLE") => Some(TimeEntryPauseReason::Idle),
        Some("MANUAL") => Some(TimeEntryPauseReason::Manual),
        Some("PERMISSION_REQUIRED") => Some(TimeEntryPauseReason::PermissionRequired),
        _ => None,
    };
    Ok(TimeEntry {
        id: raw.id,
        client_uuid: raw.client_uuid,
        user_id: raw.user_id,
        lark_task_guid: raw.lark_task_guid,
        source: raw.source,
        revision,
        started_at: raw.started_at,
        ended_at: raw.ended_at,
        pause_reason,
        close_reason,
        segments: raw.segments,
        shape: EntryShape::from_doc(&doc, &PARSE_ADDS),
    })
}

/// Port of `sqliteStore.ts::asSyncState`: anything unknown is `pending_create`.
#[must_use]
pub fn as_sync_state(value: &str) -> EntrySyncState {
    match value {
        "pending_update" => EntrySyncState::PendingUpdate,
        "synced" => EntrySyncState::Synced,
        _ => EntrySyncState::PendingCreate,
    }
}

/// Port of `asFiniteNumber`.
fn finite(value: &Value, key: &str) -> Option<f64> {
    value.get(key)?.as_f64().filter(|n| n.is_finite())
}

/// `typeof raw.entryId === 'string' && raw.entryId.length > 0`.
fn entry_id(value: &Value) -> Option<String> {
    value
        .get("entryId")?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// Port of `asExitIntent`.
#[must_use]
pub fn as_exit_intent(value: &Value) -> Option<TimerExitIntent> {
    let reason = match value.get("reason")?.as_str()? {
        "quit" => TimerExitReason::Quit,
        "update" => TimerExitReason::Update,
        "shutdown" => TimerExitReason::Shutdown,
        _ => return None,
    };
    Some(TimerExitIntent {
        reason,
        entry_id: entry_id(value)?,
        observed_at: finite(value, "observedAt")?,
    })
}

/// Port of `asRecoveryNotice`.
#[must_use]
pub fn as_recovery_notice(value: &Value) -> Option<ReadRecoveryNotice> {
    let reason = match value.get("reason")?.as_str()? {
        "unexpected_shutdown" => TimerRecoveryReason::UnexpectedShutdown,
        "sleep_stop" => TimerRecoveryReason::SleepStop,
        "lock_stop" => TimerRecoveryReason::LockStop,
        "server_finalized" => TimerRecoveryReason::ServerFinalized,
        "server_clock_corrected" => TimerRecoveryReason::ServerClockCorrected,
        _ => return None,
    };
    Some(ReadRecoveryNotice(TimerRecoveryNotice {
        entry_id: entry_id(value)?,
        recovered_at: finite(value, "recoveredAt")?,
        reason,
        observed_at: finite(value, "observedAt")?,
    }))
}

/// Port of `asAwayState`.
#[must_use]
pub fn as_away_state(value: &Value) -> Option<TimerAwayState> {
    let reason = match value.get("reason")?.as_str()? {
        "suspend" => TimerAwayReason::Suspend,
        "lock" => TimerAwayReason::Lock,
        _ => return None,
    };
    Some(TimerAwayState {
        reason,
        entry_id: entry_id(value)?,
        away_started_at: finite(value, "awayStartedAt")?,
        observed_at: finite(value, "observedAt")?,
    })
}
