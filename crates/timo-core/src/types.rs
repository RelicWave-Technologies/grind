//! Domain types for time tracking. Time is epoch milliseconds as a JavaScript
//! number (`f64`, usually fractional) so all logic is pure and deterministic,
//! without a clock, DB, or window system.
//!
//! Port of `packages/core/src/types.ts`. Every type serializes to the JSON the
//! TypeScript object has: camelCase fields, the same enum strings, and the same
//! `undefined` / `null` split.

use serde::ser::SerializeMap;
use serde::{Deserialize, Deserializer, Serialize, Serializer, de};

mod shape;
pub use shape::{EntryShape, JsonValue, PARSE_ADDS};

/// Port of `packages/core/src/types.ts::SegmentKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SegmentKind {
    Work,
    Meeting,
    IdleTrimmed,
}

impl SegmentKind {
    /// The TypeScript string literal.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Work => "WORK",
            Self::Meeting => "MEETING",
            Self::IdleTrimmed => "IDLE_TRIMMED",
        }
    }
}

/// Port of `packages/core/src/types.ts::TimeEntrySource`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TimeEntrySource {
    Auto,
    Manual,
}

impl TimeEntrySource {
    /// The TypeScript string literal.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "AUTO",
            Self::Manual => "MANUAL",
        }
    }
}

/// Port of `packages/core/src/types.ts::TimeEntryPauseReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TimeEntryPauseReason {
    Idle,
    Manual,
    PermissionRequired,
}

/// Port of `packages/core/src/types.ts::TimeEntryCloseReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TimeEntryCloseReason {
    Agent,
    AgentRecovery,
    LeaseExpired,
    Superseded,
    LegacyReconciled,
}

/// The `Extract<TimeEntryCloseReason, 'AGENT' | 'AGENT_RECOVERY'>` that
/// `TimeEntry.closeReason` is typed as.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AgentCloseReason {
    Agent,
    AgentRecovery,
}

impl AgentCloseReason {
    /// The TypeScript string literal.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Agent => "AGENT",
            Self::AgentRecovery => "AGENT_RECOVERY",
        }
    }
}

/// Port of `packages/core/src/types.ts::Segment`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Segment {
    pub id: String,
    pub kind: SegmentKind,
    /// Epoch ms, inclusive start. A JavaScript number: usually fractional.
    pub started_at: f64,
    /// Epoch ms, exclusive end; `None` (JSON `null`) = currently open.
    pub ended_at: Option<f64>,
}

/// Port of `packages/core/src/types.ts::TimeEntry`.
///
/// Serializes through [`EntryShape`]: an entry read from a stored row writes its keys
/// back in the order the row had them, with the keys this version does not know.
#[derive(Debug, Clone, PartialEq)]
pub struct TimeEntry {
    pub id: String,
    /// Client-generated idempotency key (ULID).
    pub client_uuid: String,
    pub user_id: String,
    /// `larkTaskGuid?: string | null`, three states: `None` = the property is
    /// absent (`undefined`), `Some(None)` = `null`, `Some(Some(guid))` = a guid.
    pub lark_task_guid: Option<Option<String>>,
    pub source: TimeEntrySource,
    /// Monotonic local mutation revision. Legacy local rows normalize to 0.
    pub revision: f64,
    /// Epoch ms; equals the first segment's `startedAt`.
    pub started_at: f64,
    /// Epoch ms; `None` (JSON `null`) while the entry is still running.
    pub ended_at: Option<f64>,
    pub pause_reason: Option<TimeEntryPauseReason>,
    pub close_reason: Option<AgentCloseReason>,
    pub segments: Vec<Segment>,
    /// Key order and unknown keys of the stored object; `Default` for a fresh entry.
    pub shape: EntryShape,
}

/// The typed members of a `TimeEntry`, as deserialized (the layout is read separately).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(
    clippy::option_option,
    reason = "`larkTaskGuid` is absent, null or a string, as in `TimeEntry`"
)]
struct EntryFields {
    id: String,
    client_uuid: String,
    user_id: String,
    #[serde(default, deserialize_with = "present_or_null")]
    lark_task_guid: Option<Option<String>>,
    source: TimeEntrySource,
    revision: f64,
    started_at: f64,
    ended_at: Option<f64>,
    pause_reason: Option<TimeEntryPauseReason>,
    close_reason: Option<AgentCloseReason>,
    segments: Vec<Segment>,
}

impl Serialize for TimeEntry {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        self.shape.write(self, &mut map)?;
        map.end()
    }
}

impl<'de> Deserialize<'de> for TimeEntry {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let JsonValue::Object(doc) = JsonValue::deserialize(deserializer)? else {
            return Err(de::Error::custom("a time entry is a JSON object"));
        };
        let fields: EntryFields = serde_json::from_value(JsonValue::Object(doc.clone()).to_serde())
            .map_err(de::Error::custom)?;
        Ok(Self {
            id: fields.id,
            client_uuid: fields.client_uuid,
            user_id: fields.user_id,
            lark_task_guid: fields.lark_task_guid,
            source: fields.source,
            revision: fields.revision,
            started_at: fields.started_at,
            ended_at: fields.ended_at,
            pause_reason: fields.pause_reason,
            close_reason: fields.close_reason,
            segments: fields.segments,
            shape: EntryShape::from_doc(&doc, &[]),
        })
    }
}

/// Deserialize a field that was present: `null` becomes `Some(None)`. Paired
/// with `#[serde(default)]`, an absent field stays `None`.
pub fn present_or_null<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

/// Durations that count as worked time. `IdleTrimmed` never counts.
///
/// Port of `packages/core/src/types.ts::COUNTED_KINDS`.
pub const COUNTED_KINDS: [SegmentKind; 2] = [SegmentKind::Work, SegmentKind::Meeting];

/// `COUNTED_KINDS.includes(kind)`.
#[must_use]
pub fn is_counted(kind: SegmentKind) -> bool {
    COUNTED_KINDS.contains(&kind)
}
