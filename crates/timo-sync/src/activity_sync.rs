//! Byte-bounded activity upload. Port of
//! `legacy/agent/src/main/services/activity/sync.ts` (SC-67).
//!
//! A batch must stay under the API's body-size limit: a count-based batch that
//! never shrinks would, once rejected with 413, block that user's activity
//! forever. So the batch is bounded by BYTES, and the per-sample text fields
//! are capped, so neither a run of long URLs nor one giant sample can blow past
//! the limit.

use serde::{Deserialize, Serialize};

use crate::api::ApiClient;
use crate::error::ApiError;
use crate::http::RequestOptions;
use crate::tokens::TokenStore;
use crate::wire::{iso, json_body};

/// `MAX_BATCH_ROWS`: also the server-side schema cap.
pub const MAX_BATCH_ROWS: usize = 500;
/// `MAX_BATCH_BYTES`: headroom under the API's activity-route limit.
pub const MAX_BATCH_BYTES: usize = 48 * 1024;
/// `{"samples":[ ... ]}` envelope.
const ENVELOPE_BYTES: usize = 20;
/// `ACTIVITY_METADATA_MAX_CHARS`.
pub const MAX_APP_CHARS: usize = 120;
pub const MAX_BUNDLE_CHARS: usize = 200;
pub const MAX_TITLE_CHARS: usize = 300;
pub const MAX_URL_CHARS: usize = 2048;

/// Port of `activity/store.ts::ActivityRow` (what the sender reads of it).
/// Numbers are `f64` because they are JavaScript numbers read from SQLite.
#[derive(Debug, Clone, PartialEq)]
pub struct ActivityRow {
    pub id: String,
    pub time_entry_id: Option<String>,
    pub bucket_start: f64,
    pub keystrokes: f64,
    pub clicks: f64,
    pub mouse_distance_px: f64,
    pub scroll_events: f64,
    pub iki_cv: Option<f64>,
    pub move_speed_cv: Option<f64>,
    pub path_straightness: Option<f64>,
    pub active_app: Option<String>,
    pub active_app_bundle: Option<String>,
    pub active_title: Option<String>,
    pub active_url: Option<String>,
}

/// The slice of `ActivityStore` the sender uses. Implemented by the app over
/// `timo_store`'s activity store.
pub trait ActivityOutbox: Send + Sync {
    /// `unsynced(limit)`: oldest bucket first.
    fn unsynced(&self, limit: usize) -> Result<Vec<ActivityRow>, String>;
    /// `markSynced(ids)`.
    fn mark_synced(&self, ids: &[String]) -> Result<(), String>;
}

/// `ActivitySampleInput`, in the key order `toInput` writes.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySampleInput {
    pub id: String,
    pub time_entry_id: Option<String>,
    pub bucket_start: String,
    pub keystrokes: f64,
    pub clicks: f64,
    pub mouse_distance_px: f64,
    pub scroll_events: f64,
    pub iki_cv: Option<f64>,
    pub move_speed_cv: Option<f64>,
    pub path_straightness: Option<f64>,
    pub active_app: Option<String>,
    pub active_app_bundle: Option<String>,
    pub active_title: Option<String>,
    pub active_url: Option<String>,
}

#[derive(Serialize)]
struct SamplesRequest<'a> {
    samples: Vec<&'a ActivitySampleInput>,
}

/// `ActivitySamplesResponse`, cast and not parsed: an older API omits `detached`.
#[derive(Debug, Default, Deserialize)]
struct SamplesResponse {
    #[serde(default)]
    detached: Option<f64>,
}

/// Why a flush failed.
#[derive(Debug, Clone, thiserror::Error)]
pub enum FlushError {
    #[error("{0}")]
    Api(#[from] ApiError),
    #[error("{0}")]
    Store(String),
}

/// Port of `sync.ts::cap`. Counts UTF-16 code units, as `String.length` does,
/// and drops a trailing high surrogate so the cut never leaves half a character
/// behind (which the server's driver rejects, losing the whole batch).
#[must_use]
pub fn cap(text: Option<&str>, max_chars: usize) -> Option<String> {
    let text = text?;
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() <= max_chars {
        return Some(text.to_owned());
    }
    let mut cut = units.get(..max_chars).unwrap_or_default();
    if let Some((last, rest)) = cut.split_last()
        && (0xD800..=0xDBFF).contains(last)
    {
        cut = rest;
    }
    Some(String::from_utf16_lossy(cut))
}

/// Port of `sync.ts::toInput`.
pub fn to_input(row: &ActivityRow) -> Result<ActivitySampleInput, ApiError> {
    Ok(ActivitySampleInput {
        id: row.id.clone(),
        time_entry_id: row.time_entry_id.clone(),
        bucket_start: iso(row.bucket_start)?,
        keystrokes: row.keystrokes,
        clicks: row.clicks,
        mouse_distance_px: row.mouse_distance_px,
        scroll_events: row.scroll_events,
        iki_cv: row.iki_cv,
        move_speed_cv: row.move_speed_cv,
        path_straightness: row.path_straightness,
        active_app: cap(row.active_app.as_deref(), MAX_APP_CHARS),
        active_app_bundle: cap(row.active_app_bundle.as_deref(), MAX_BUNDLE_CHARS),
        active_title: cap(row.active_title.as_deref(), MAX_TITLE_CHARS),
        active_url: cap(row.active_url.as_deref(), MAX_URL_CHARS),
    })
}

/// The longest prefix of `rows` whose JSON stays under the byte budget: always
/// at least one row, so a single large sample still makes forward progress.
/// Returns the packed samples and the byte total the TypeScript logs.
pub fn pack_batch(rows: &[ActivityRow]) -> Result<(Vec<ActivitySampleInput>, usize), ApiError> {
    let mut batch = Vec::new();
    let mut bytes = ENVELOPE_BYTES;
    for row in rows {
        let input = to_input(row)?;
        let size = json_body(&input)?.len() + 1;
        if !batch.is_empty() && bytes + size > MAX_BATCH_BYTES {
            break;
        }
        batch.push(input);
        bytes += size;
    }
    Ok((batch, bytes))
}

/// `POST /v1/activity-samples` body: `{"samples":[...]}`.
pub fn batch_body(batch: &[ActivitySampleInput]) -> Result<String, ApiError> {
    json_body(&SamplesRequest {
        samples: batch.iter().collect(),
    })
}

/// Port of `sync.ts::flushActivity`: push unsynced samples in one byte-bounded
/// batch. Returns the number synced (0 when nothing is pending). The backlog
/// drains on later calls, in safe chunks.
pub async fn flush_activity<S: TokenStore, O: ActivityOutbox>(
    api: &ApiClient<S>,
    store: &O,
    is_time_entry_pending_create: &(dyn Fn(&str) -> bool + Sync),
) -> Result<usize, FlushError> {
    let rows: Vec<ActivityRow> = store
        .unsynced(MAX_BATCH_ROWS)
        .map_err(FlushError::Store)?
        .into_iter()
        .filter(|r| {
            r.time_entry_id
                .as_deref()
                .is_none_or(|id| !is_time_entry_pending_create(id))
        })
        .collect();
    if rows.is_empty() {
        return Ok(0);
    }
    match send_batch(api, store, &rows).await {
        Ok(sent) => Ok(sent),
        Err(err) => {
            tracing::warn!(err = %err, "activity flush failed");
            Err(err)
        }
    }
}

async fn send_batch<S: TokenStore, O: ActivityOutbox>(
    api: &ApiClient<S>,
    store: &O,
    rows: &[ActivityRow],
) -> Result<usize, FlushError> {
    let (batch, bytes) = pack_batch(rows)?;
    let options = RequestOptions::post(Some(batch_body(&batch)?));
    let response: SamplesResponse = api.api("/v1/activity-samples", &options).await?;
    let ids: Vec<String> = batch.iter().map(|s| s.id.clone()).collect();
    store.mark_synced(&ids).map_err(FlushError::Store)?;
    if response.detached.is_some_and(|d| d > 0.0) {
        tracing::warn!(count = ?response.detached, "activity samples accepted without unavailable timer parent");
    }
    tracing::debug!(count = batch.len(), bytes, "flushed activity samples");
    Ok(batch.len())
}
