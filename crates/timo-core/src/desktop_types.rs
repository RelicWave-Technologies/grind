//! The wire and shared types the desktop services exchange: `@grind/types`
//! `agent.ts` (agent state, platform, permission and launch-at-login snapshots)
//! and `legacy/agent/src/shared/tracking.ts` (timer status). Field order is the
//! TypeScript object literals', which is the order they are serialized in.

use serde::{Deserialize, Serialize};

/// `AgentState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentState {
    #[serde(rename = "IDLE")]
    Idle,
    #[serde(rename = "RUNNING")]
    Running,
    #[serde(rename = "PAUSED_IDLE")]
    PausedIdle,
    #[serde(rename = "PAUSED_PERMISSION")]
    PausedPermission,
    #[serde(rename = "OFFLINE")]
    Offline,
}

/// `Platform`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Platform {
    Darwin,
    Win32,
    Linux,
}

/// `ScreenStatus` / `ScreenPermissionStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ScreenStatus {
    #[serde(rename = "granted")]
    Granted,
    #[serde(rename = "denied")]
    Denied,
    #[serde(rename = "restricted")]
    Restricted,
    #[serde(rename = "not-determined")]
    NotDetermined,
    #[serde(rename = "unknown")]
    Unknown,
}

/// `CaptureHealth`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CaptureHealth {
    #[serde(rename = "ok")]
    Ok,
    #[serde(rename = "no-permission")]
    NoPermission,
    #[serde(rename = "empty")]
    Empty,
    #[serde(rename = "error")]
    Error,
    #[serde(rename = "unknown")]
    Unknown,
}

/// `ScreenUiState` / `ScreenPermissionState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ScreenUiState {
    #[serde(rename = "ok")]
    Ok,
    #[serde(rename = "needs-grant")]
    NeedsGrant,
    #[serde(rename = "needs-settings")]
    NeedsSettings,
    #[serde(rename = "needs-restart")]
    NeedsRestart,
}

/// Port of `screenUiState` (`services/permissions.ts`): given the reported
/// status and the last capture outcome, what should the UI show?
#[must_use]
pub fn screen_ui_state(status: ScreenStatus, health: CaptureHealth) -> ScreenUiState {
    match status {
        ScreenStatus::Granted => {
            if matches!(health, CaptureHealth::Empty | CaptureHealth::Error) {
                ScreenUiState::NeedsRestart
            } else {
                ScreenUiState::Ok
            }
        }
        ScreenStatus::NotDetermined | ScreenStatus::Unknown => ScreenUiState::NeedsGrant,
        ScreenStatus::Denied | ScreenStatus::Restricted => ScreenUiState::NeedsSettings,
    }
}

/// `DesktopPermissionSnapshot['screen']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScreenPermission {
    pub status: ScreenStatus,
    pub health: CaptureHealth,
    pub state: ScreenUiState,
}

/// `DesktopPermissionSnapshot['accessibility']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(
    clippy::struct_excessive_bools,
    reason = "mirrors the wire type's five independent flags"
)]
pub struct AccessibilityPermission {
    pub trusted: bool,
    pub ready: bool,
    pub recording: bool,
    pub capturing: bool,
    pub hook_running: bool,
}

/// `DesktopPermissionSnapshot`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesktopPermissionSnapshot {
    pub screen: ScreenPermission,
    pub accessibility: AccessibilityPermission,
}

/// `LaunchAtLoginState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LaunchAtLoginState {
    #[serde(rename = "READY")]
    Ready,
    #[serde(rename = "NEEDS_INSTALL")]
    NeedsInstall,
    #[serde(rename = "NEEDS_REGISTRATION")]
    NeedsRegistration,
    #[serde(rename = "NEEDS_APPROVAL")]
    NeedsApproval,
    #[serde(rename = "NEEDS_REPAIR")]
    NeedsRepair,
    #[serde(rename = "BLOCKED")]
    Blocked,
    #[serde(rename = "UNAVAILABLE")]
    Unavailable,
}

/// `LaunchOrigin`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum LaunchOrigin {
    #[serde(rename = "LOGIN_ITEM")]
    LoginItem,
    #[serde(rename = "USER")]
    User,
    #[serde(rename = "UNKNOWN")]
    Unknown,
}

/// `LaunchAtLoginSnapshot`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchAtLoginSnapshot {
    pub state: LaunchAtLoginState,
    pub ready: bool,
    pub opened_at_login: bool,
    pub origin: LaunchOrigin,
}

/// `TimerPauseReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TimerPauseReason {
    #[serde(rename = "IDLE")]
    Idle,
    #[serde(rename = "MANUAL")]
    Manual,
    #[serde(rename = "PERMISSION_REQUIRED")]
    PermissionRequired,
}

/// `TimerStatus` (`shared/tracking.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
        pause_reason: Option<TimerPauseReason>,
    },
}
