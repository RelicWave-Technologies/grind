//! Domain types for time tracking. Time is epoch milliseconds as a JavaScript
//! number (`f64`, usually fractional) so all logic is pure and deterministic,
//! without a clock, DB, or window system.
//!
//! Port of `packages/core/src/types.ts`. Every type serializes to the JSON the
//! TypeScript object has: camelCase fields, the same enum strings, and the same
//! `undefined` / `null` split.

use serde::{Deserialize, Deserializer, Serialize};

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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeEntry {
    pub id: String,
    /// Client-generated idempotency key (ULID).
    pub client_uuid: String,
    pub user_id: String,
    /// `larkTaskGuid?: string | null`, three states: `None` = the property is
    /// absent (`undefined`), `Some(None)` = `null`, `Some(Some(guid))` = a guid.
    #[serde(
        default,
        deserialize_with = "present_or_null",
        skip_serializing_if = "Option::is_none"
    )]
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
