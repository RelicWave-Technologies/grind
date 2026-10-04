//! Value types of the timer engine.
//!
//! Port of `legacy/agent/src/main/services/timer/types.ts` (the data types; the
//! injected interfaces are in [`super::traits`]) and `legacy/agent/src/shared/tracking.ts`.
//! Field order is the order of the TypeScript object literals, because these
//! are written to SQLite with `JSON.stringify` and read back by equality.

use core::ops::Deref;

use serde::ser::SerializeStruct;
use serde::{Deserialize, Serialize, Serializer};

use crate::today_ledger::LedgerSyncState;
use crate::types::{TimeEntry, TimeEntryPauseReason};

/// Port of `types.ts::EntrySyncState`. Same three states the ledger reconciler
/// uses, so the one type serves both.
pub type EntrySyncState = LedgerSyncState;

/// Port of `types.ts::PendingEntrySyncState`: `Exclude<EntrySyncState, 'synced'>`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PendingEntrySyncState {
    PendingCreate,
    PendingUpdate,
}

impl PendingEntrySyncState {
    /// The `sync_state` column text.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::PendingCreate => "pending_create",
            Self::PendingUpdate => "pending_update",
        }
    }
}

impl From<PendingEntrySyncState> for EntrySyncState {
    fn from(state: PendingEntrySyncState) -> Self {
        match state {
            PendingEntrySyncState::PendingCreate => Self::PendingCreate,
            PendingEntrySyncState::PendingUpdate => Self::PendingUpdate,
        }
    }
}

/// Port of `types.ts::TimerExitReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimerExitReason {
    Quit,
    Update,
    Shutdown,
}

/// Port of `types.ts::TimerAwayReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimerAwayReason {
    Suspend,
    Lock,
}

/// Port of `types.ts::TimerRecoveryReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimerRecoveryReason {
    UnexpectedShutdown,
    SleepStop,
    LockStop,
    ServerFinalized,
    ServerClockCorrected,
}

/// Port of `types.ts::TimerExitIntent`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerExitIntent {
    pub reason: TimerExitReason,
    pub entry_id: String,
    pub observed_at: f64,
}

/// Port of `types.ts::TimerRecoveryNotice`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerRecoveryNotice {
    pub entry_id: String,
    pub recovered_at: f64,
    pub reason: TimerRecoveryReason,
    pub observed_at: f64,
}

/// A notice as `getRecoveryNotice()` returns it. `asRecoveryNotice` builds a new object,
/// `{ reason, entryId, recoveredAt, observedAt }`, so a notice read back serializes in that
/// order, not in the order [`TimerRecoveryNotice`] was written (and stored) in.
#[derive(Debug, Clone, PartialEq)]
pub struct ReadRecoveryNotice(pub TimerRecoveryNotice);

impl Deref for ReadRecoveryNotice {
    type Target = TimerRecoveryNotice;

    fn deref(&self) -> &TimerRecoveryNotice {
        &self.0
    }
}

impl Serialize for ReadRecoveryNotice {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut notice = serializer.serialize_struct("TimerRecoveryNotice", 4)?;
        notice.serialize_field("reason", &self.0.reason)?;
        notice.serialize_field("entryId", &self.0.entry_id)?;
        notice.serialize_field("recoveredAt", &self.0.recovered_at)?;
        notice.serialize_field("observedAt", &self.0.observed_at)?;
        notice.end()
    }
}

/// Port of `types.ts::TimerAwayState`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerAwayState {
    pub reason: TimerAwayReason,
    pub entry_id: String,
    pub away_started_at: f64,
    pub observed_at: f64,
}

/// Port of `types.ts::TimerRecoveryResult`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerRecoveryResult {
    pub entry_id: String,
    pub recovered_at: f64,
    pub notice: TimerRecoveryNotice,
}

/// Port of `types.ts::UnsyncedEntry`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnsyncedEntry {
    pub entry: TimeEntry,
    pub sync_state: PendingEntrySyncState,
}

/// Port of `types.ts::TimerOwner`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerOwner {
    pub user_id: String,
    pub workspace_id: String,
}

/// The `{id, clientUuid}` pairs of `EntryStore.claimServerMatchedEntries`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryMatch {
    pub id: String,
    pub client_uuid: String,
}

/// The `{revision, hash}` argument of `EntryStore.markSynced`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Acknowledgement {
    pub revision: f64,
    pub hash: String,
}

/// Port of `types.ts::StartArgs`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct StartArgs {
    /// `larkTaskGuid?: string | null`: absent and `null` behave the same.
    pub lark_task_guid: Option<String>,
}

/// The `{start, end}` a `BusinessDayProvider` returns.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct DayWindow {
    pub start: f64,
    pub end: f64,
}

/// Port of `@grind/types::TodayLedgerMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TodayLedgerMode {
    Off,
    Shadow,
    Visible,
}

/// Port of `shared/tracking.ts::TimerStatus`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "state", rename_all_fields = "camelCase")]
pub enum TimerStatus {
    #[serde(rename = "IDLE")]
    Idle { worked_ms: f64 },
    #[serde(rename = "RUNNING")]
    Running {
        entry_id: String,
        revision: f64,
        lark_task_guid: Option<String>,
        started_at: f64,
        segment_started_at: Option<f64>,
        worked_ms: f64,
        paused: bool,
        pause_reason: Option<TimeEntryPauseReason>,
    },
}

impl TimerStatus {
    /// `status.workedMs`, present on both variants.
    #[must_use]
    pub const fn worked_ms(&self) -> f64 {
        match self {
            Self::Idle { worked_ms } | Self::Running { worked_ms, .. } => *worked_ms,
        }
    }
}

/// Port of `shared/tracking.ts::CapabilityState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CapabilityState {
    NotRequired,
    Ready,
    Checking,
    NeedsGrant,
    NeedsSettings,
    NeedsRestart,
    Failed,
}

/// Port of `shared/tracking.ts::BlockingCapability`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum BlockingCapability {
    ScreenRecording,
    Accessibility,
}

/// Port of `shared/tracking.ts::TrackingReadiness`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackingReadiness {
    pub ready: bool,
    pub checked_at: String,
    pub screen_recording: CapabilityState,
    pub accessibility: CapabilityState,
    pub blocking_capabilities: Vec<BlockingCapability>,
}
