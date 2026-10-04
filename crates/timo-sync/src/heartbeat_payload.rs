//! The heartbeat request body. Port of
//! `legacy/agent/src/main/services/heartbeatPayload.ts` and the zod shapes in
//! `packages/types/src/agent.ts` (`HeartbeatRequest`, `DesktopPermissionSnapshot`,
//! `LaunchAtLoginSnapshot`). Field order is the JSON key order.

use serde::Serialize;

use crate::config::Platform;
use crate::error::ApiError;
use crate::wire::iso;

/// `AgentState` (the values a heartbeat sends).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum AgentState {
    Idle,
    Running,
    PausedIdle,
    PausedPermission,
}

/// `TimerPauseReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PauseReason {
    Idle,
    Manual,
    PermissionRequired,
}

/// The slice of `TimerStatus` a heartbeat reads (`shared/tracking.ts`).
#[derive(Debug, Clone, PartialEq)]
pub enum HeartbeatTimerStatus {
    Idle,
    Running {
        entry_id: String,
        revision: i64,
        paused: bool,
        pause_reason: Option<PauseReason>,
    },
}

/// Port of `heartbeatPayload.ts::agentStateFromTimer`: any pause other than a
/// missing permission, MANUAL included, is `PAUSED_IDLE`.
#[must_use]
pub const fn agent_state_from_timer(status: &HeartbeatTimerStatus) -> AgentState {
    match status {
        HeartbeatTimerStatus::Idle => AgentState::Idle,
        HeartbeatTimerStatus::Running { paused: false, .. } => AgentState::Running,
        HeartbeatTimerStatus::Running {
            pause_reason: Some(PauseReason::PermissionRequired),
            ..
        } => AgentState::PausedPermission,
        HeartbeatTimerStatus::Running { .. } => AgentState::PausedIdle,
    }
}

/// `ScreenPermissionStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScreenPermissionStatus {
    Granted,
    Denied,
    Restricted,
    NotDetermined,
    Unknown,
}

/// `CaptureHealth`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureHealth {
    Ok,
    NoPermission,
    Empty,
    Error,
    Unknown,
}

/// `ScreenPermissionState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScreenPermissionState {
    Ok,
    NeedsGrant,
    NeedsSettings,
    NeedsRestart,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ScreenPermission {
    pub status: ScreenPermissionStatus,
    pub health: CaptureHealth,
    pub state: ScreenPermissionState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(
    clippy::struct_excessive_bools,
    reason = "the five flags are the wire shape of DesktopPermissionSnapshot.accessibility"
)]
pub struct AccessibilityPermission {
    pub trusted: bool,
    pub ready: bool,
    pub recording: bool,
    pub capturing: bool,
    pub hook_running: bool,
}

/// `DesktopPermissionSnapshot`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PermissionSnapshot {
    pub screen: ScreenPermission,
    pub accessibility: AccessibilityPermission,
}

/// `LaunchAtLoginState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LaunchAtLoginState {
    Ready,
    NeedsInstall,
    NeedsRegistration,
    NeedsApproval,
    NeedsRepair,
    Blocked,
    Unavailable,
}

/// `LaunchOrigin`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum LaunchOrigin {
    LoginItem,
    User,
    Unknown,
}

/// `LaunchAtLoginSnapshot`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartupSnapshot {
    pub state: LaunchAtLoginState,
    pub ready: bool,
    pub opened_at_login: bool,
    pub origin: LaunchOrigin,
}

/// `TimerCheckpoint`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerCheckpoint {
    pub entry_id: String,
    pub revision: i64,
    pub state: AgentState,
    pub observed_at: String,
}

/// `HeartbeatRequest`. `permissions` and `startup` are spread in only when given.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatRequest {
    pub agent_version: String,
    pub platform: Platform,
    pub state: AgentState,
    pub active_entry_id: Option<String>,
    pub tracking_protocol_version: u8,
    pub timer_checkpoint: Option<TimerCheckpoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<PermissionSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub startup: Option<StartupSnapshot>,
}

/// Everything `buildHeartbeatRequest` takes.
#[derive(Debug, Clone)]
pub struct HeartbeatArgs {
    pub agent_version: String,
    pub platform: Platform,
    pub timer_status: HeartbeatTimerStatus,
    pub permissions: Option<PermissionSnapshot>,
    pub startup: Option<StartupSnapshot>,
    /// `observedAt` (the server-aligned clock, fractional); `Date.now()` when the
    /// TypeScript omits it, so the caller injects it.
    pub observed_at: f64,
}

/// Port of `heartbeatPayload.ts::buildHeartbeatRequest`.
pub fn build_heartbeat_request(args: HeartbeatArgs) -> Result<HeartbeatRequest, ApiError> {
    let state = agent_state_from_timer(&args.timer_status);
    let (active_entry_id, timer_checkpoint) = match &args.timer_status {
        HeartbeatTimerStatus::Idle => (None, None),
        HeartbeatTimerStatus::Running {
            entry_id, revision, ..
        } => (
            Some(entry_id.clone()),
            Some(TimerCheckpoint {
                entry_id: entry_id.clone(),
                revision: (*revision).max(1),
                state,
                observed_at: iso(args.observed_at)?,
            }),
        ),
    };
    Ok(HeartbeatRequest {
        agent_version: args.agent_version,
        platform: args.platform,
        state,
        active_entry_id,
        tracking_protocol_version: 2,
        timer_checkpoint,
        permissions: args.permissions,
        startup: args.startup,
    })
}
