//! Stable agent-owned payload used for exact revision acknowledgement.
//!
//! Port of `packages/core/src/timerLedger.ts`.

use serde::Deserialize;

use crate::error::CoreError;
use crate::js::collate::{LocaleCollator, collator};
use crate::js::date::{self, DateParse};
use crate::js::json::quote;
use crate::js::number::{number_to_string as fmt, sort_cmp};
use crate::types::{SegmentKind, TimeEntrySource};

/// Port of `packages/core/src/timerLedger.ts::Timestamp` (`number | string | Date`).
///
/// A `Date` object serializes to its ISO string, so it arrives here as `Text`.
/// `Number` carries an epoch-millisecond value, usually fractional.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum Timestamp {
    Number(f64),
    Text(String),
}

/// Port of the inline segment type of `CanonicalTimerEntryLike`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalSegmentLike {
    pub id: String,
    pub kind: SegmentKind,
    pub started_at: Timestamp,
    pub ended_at: Option<Timestamp>,
}

/// Port of `packages/core/src/timerLedger.ts::CanonicalTimerEntryLike`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonicalTimerEntryLike {
    pub id: String,
    pub client_uuid: String,
    pub lark_task_guid: Option<String>,
    pub source: TimeEntrySource,
    pub revision: Option<f64>,
    pub started_at: Timestamp,
    pub ended_at: Option<Timestamp>,
    pub close_reason: Option<String>,
    pub segments: Vec<CanonicalSegmentLike>,
}

/// Port of `packages/core/src/timerLedger.ts::epoch`, applied to every
/// timestamp of an entry.
///
/// A string this port cannot parse ([`DateParse::Unsupported`]) is remembered
/// and reported at the end rather than thrown on the spot, because JavaScript
/// would have gone on to evaluate the remaining timestamps, and a later one that
/// is plainly invalid throws `invalid_timer_timestamp` whatever the unsupported
/// one meant (a value, or NaN: both lead to the same error).
#[derive(Default)]
struct Epochs {
    first_unsupported: Option<String>,
}

impl Epochs {
    fn epoch(&mut self, value: &Timestamp) -> Result<f64, CoreError> {
        match value {
            Timestamp::Number(n) => Ok(*n),
            Timestamp::Text(s) => match date::parse(s) {
                DateParse::Time(t) => Ok(t),
                DateParse::Invalid => Err(CoreError::InvalidTimerTimestamp),
                DateParse::Unsupported => {
                    self.first_unsupported.get_or_insert_with(|| s.clone());
                    // Placeholder: nothing is rendered or sorted if one was seen.
                    Ok(0.0)
                }
            },
        }
    }

    fn epoch_or_null(&mut self, value: Option<&Timestamp>) -> Result<Option<f64>, CoreError> {
        value.map(|v| self.epoch(v)).transpose()
    }

    fn finish(self) -> Result<(), CoreError> {
        match self.first_unsupported {
            Some(s) => Err(CoreError::UnsupportedTimerTimestamp(s)),
            None => Ok(()),
        }
    }
}

/// A segment after `epoch` has been applied to its timestamps.
struct CanonicalSegment<'a> {
    id: &'a str,
    kind: SegmentKind,
    started_at: f64,
    ended_at: Option<f64>,
}

/// Stable agent-owned payload used for exact revision acknowledgement: the
/// compact `JSON.stringify` of the entry with timestamps normalized to epoch
/// milliseconds and segments sorted by `(startedAt, id.localeCompare)`.
///
/// Port of `packages/core/src/timerLedger.ts::canonicalTimerEntryPayload`.
/// Evaluation order is the TypeScript order (segments first, then the entry's
/// own timestamps), so the first invalid timestamp is the same one.
pub fn canonical_timer_entry_payload(entry: &CanonicalTimerEntryLike) -> Result<String, CoreError> {
    canonical_timer_entry_payload_with(entry, &collator()?)
}

/// [`canonical_timer_entry_payload`] under a given collator: `localeCompare` follows the ICU default
/// locale of the process, which a test (or a shell that has not set the default) can vary.
pub fn canonical_timer_entry_payload_with(
    entry: &CanonicalTimerEntryLike,
    collator: &LocaleCollator,
) -> Result<String, CoreError> {
    let mut epochs = Epochs::default();
    let mut segments = Vec::with_capacity(entry.segments.len());
    for segment in &entry.segments {
        segments.push(CanonicalSegment {
            id: &segment.id,
            kind: segment.kind,
            started_at: epochs.epoch(&segment.started_at)?,
            ended_at: epochs.epoch_or_null(segment.ended_at.as_ref())?,
        });
    }
    let started_at = epochs.epoch(&entry.started_at)?;
    let ended_at = epochs.epoch_or_null(entry.ended_at.as_ref())?;
    epochs.finish()?;
    segments.sort_by(|a, b| {
        sort_cmp(a.started_at, b.started_at).then_with(|| collator.compare(a.id, b.id))
    });
    Ok(render(entry, started_at, ended_at, &segments))
}

fn render(
    entry: &CanonicalTimerEntryLike,
    started_at: f64,
    ended_at: Option<f64>,
    segments: &[CanonicalSegment<'_>],
) -> String {
    let mut rendered = Vec::with_capacity(segments.len());
    for s in segments {
        rendered.push(format!(
            "{{\"id\":{},\"kind\":{},\"startedAt\":{},\"endedAt\":{}}}",
            quote(s.id),
            quote(s.kind.as_str()),
            fmt(s.started_at),
            number_or_null(s.ended_at)
        ));
    }
    format!(
        "{{\"id\":{},\"clientUuid\":{},\"larkTaskGuid\":{},\"source\":{},\"revision\":{},\"startedAt\":{},\"endedAt\":{},\"closeReason\":{},\"segments\":[{}]}}",
        quote(&entry.id),
        quote(&entry.client_uuid),
        string_or_null(entry.lark_task_guid.as_deref()),
        quote(entry.source.as_str()),
        fmt(entry.revision.unwrap_or(0.0)),
        fmt(started_at),
        number_or_null(ended_at),
        string_or_null(entry.close_reason.as_deref()),
        rendered.join(",")
    )
}

fn number_or_null(value: Option<f64>) -> String {
    value.map_or_else(|| "null".to_owned(), fmt)
}

fn string_or_null(value: Option<&str>) -> String {
    value.map_or_else(|| "null".to_owned(), quote)
}
