//! The request bodies of the timer sync calls.
//!
//! Port of the payload building of `legacy/agent/src/main/services/timer/syncClient.ts`
//! (`lifecycle`, `segIso`, `HttpSyncClient.create/sync`); the HTTP transport
//! (path, method, 15 s timeout, receipt parsing) belongs to `timo-sync`, which
//! implements [`super::traits::SyncClient`] over these bodies. Key order is the
//! order the TypeScript writes the object literal, and bodies are serialized
//! with `js::ser::to_string`, so the bytes are `JSON.stringify`'s.

use serde::Serialize;

use super::error::TimerError;
use crate::js::iso::{InvalidTimeValue, to_iso_string};
use crate::js::number::max;
use crate::types::{AgentCloseReason, Segment, SegmentKind, TimeEntry, TimeEntrySource};

/// `process.platform` narrowed to the three the API accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Darwin,
    Win32,
    Linux,
}

/// `segIso`'s result.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentBody {
    pub id: String,
    pub kind: SegmentKind,
    pub started_at: String,
    pub ended_at: Option<String>,
}

/// The body of `POST /v1/time-entries`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateBody {
    pub tracking_protocol_version: u8,
    pub revision: f64,
    pub observed_at: String,
    pub close_reason: Option<AgentCloseReason>,
    pub id: String,
    pub client_uuid: String,
    pub lark_task_guid: Option<String>,
    pub source: TimeEntrySource,
    pub started_at: String,
    pub ended_at: Option<String>,
    pub agent_version: String,
    pub platform: Platform,
    pub segments: Vec<SegmentBody>,
}

/// The body of `PUT /v1/time-entries/:id/sync`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncBody {
    pub tracking_protocol_version: u8,
    pub revision: f64,
    pub observed_at: String,
    pub close_reason: Option<AgentCloseReason>,
    pub ended_at: Option<String>,
    pub segments: Vec<SegmentBody>,
}

fn range(error: InvalidTimeValue) -> TimerError {
    TimerError::Store(error.to_string())
}

/// `new Date(ms).toISOString()`; a `RangeError` for an invalid time.
fn iso(ms: f64) -> Result<String, TimerError> {
    to_iso_string(ms).map_err(range)
}

fn iso_opt(ms: Option<f64>) -> Result<Option<String>, TimerError> {
    ms.map(iso).transpose()
}

/// Port of `syncClient.ts::segIso`.
pub fn segment_body(segment: &Segment) -> Result<SegmentBody, TimerError> {
    Ok(SegmentBody {
        id: segment.id.clone(),
        kind: segment.kind,
        started_at: iso(segment.started_at)?,
        ended_at: iso_opt(segment.ended_at)?,
    })
}

fn segments(entry: &TimeEntry) -> Result<Vec<SegmentBody>, TimerError> {
    entry.segments.iter().map(segment_body).collect()
}

/// `lifecycle(entry)`'s `observedAt`: an open entry's checkpoint is "now" on the
/// server-aligned clock, sampled only when the entry has no `endedAt`.
fn observed_at(entry: &TimeEntry, now: &mut dyn FnMut() -> f64) -> Result<String, TimerError> {
    iso(entry.ended_at.unwrap_or_else(now))
}

/// Port of `HttpSyncClient.create`'s body.
pub fn create_body(
    entry: &TimeEntry,
    now: &mut dyn FnMut() -> f64,
    agent_version: &str,
    platform: Platform,
) -> Result<CreateBody, TimerError> {
    Ok(CreateBody {
        tracking_protocol_version: 2,
        revision: max(1.0, entry.revision),
        observed_at: observed_at(entry, now)?,
        close_reason: entry.close_reason,
        id: entry.id.clone(),
        client_uuid: entry.client_uuid.clone(),
        lark_task_guid: entry.lark_task_guid.clone().flatten(),
        source: entry.source,
        started_at: iso(entry.started_at)?,
        ended_at: iso_opt(entry.ended_at)?,
        agent_version: agent_version.to_owned(),
        platform,
        segments: segments(entry)?,
    })
}

/// Port of `HttpSyncClient.sync`'s body.
pub fn sync_body(entry: &TimeEntry, now: &mut dyn FnMut() -> f64) -> Result<SyncBody, TimerError> {
    Ok(SyncBody {
        tracking_protocol_version: 2,
        revision: max(1.0, entry.revision),
        observed_at: observed_at(entry, now)?,
        close_reason: entry.close_reason,
        ended_at: iso_opt(entry.ended_at)?,
        segments: segments(entry)?,
    })
}
