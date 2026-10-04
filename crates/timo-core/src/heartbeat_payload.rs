//! Port of `legacy/agent/src/main/services/heartbeatPayload.ts`: the pure
//! `HeartbeatRequest` builder.

use serde::Serialize;

use crate::desktop_types::{
    AgentState, DesktopPermissionSnapshot, LaunchAtLoginSnapshot, Platform, TimerPauseReason,
    TimerStatus,
};
use crate::js::iso::{InvalidTimeValue, to_iso_string};
use crate::js::number::max;

/// `TIMER_TRACKING_PROTOCOL_VERSION`.
pub const TIMER_TRACKING_PROTOCOL_VERSION: u8 = 2;

/// Port of `currentPlatform(nodePlatform)`: `'darwin'`, `'win32'`, else linux.
#[must_use]
pub fn current_platform(node_platform: &str) -> Platform {
    match node_platform {
        "darwin" => Platform::Darwin,
        "win32" => Platform::Win32,
        _ => Platform::Linux,
    }
}

/// Port of `agentStateFromTimer`.
#[must_use]
pub fn agent_state_from_timer(status: &TimerStatus) -> AgentState {
    match status {
        TimerStatus::Idle { .. } => AgentState::Idle,
        TimerStatus::Running {
            paused,
            pause_reason,
            ..
        } => {
            if !paused {
                AgentState::Running
            } else if *pause_reason == Some(TimerPauseReason::PermissionRequired) {
                AgentState::PausedPermission
            } else {
                AgentState::PausedIdle
            }
        }
    }
}

/// `TimerCheckpoint` of the heartbeat.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerCheckpoint {
    pub entry_id: String,
    pub revision: f64,
    pub state: AgentState,
    pub observed_at: String,
}

/// Port of `HeartbeatRequest` (as built by this module).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatRequest {
    pub agent_version: String,
    pub platform: Platform,
    pub state: AgentState,
    pub active_entry_id: Option<String>,
    pub tracking_protocol_version: u8,
    pub timer_checkpoint: Option<TimerCheckpoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permissions: Option<DesktopPermissionSnapshot>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub startup: Option<LaunchAtLoginSnapshot>,
}

/// The argument object of `buildHeartbeatRequest`.
#[derive(Debug, Clone, Copy)]
pub struct HeartbeatArgs<'a> {
    pub agent_version: &'a str,
    pub platform: Platform,
    pub timer_status: &'a TimerStatus,
    pub permissions: Option<DesktopPermissionSnapshot>,
    pub startup: Option<LaunchAtLoginSnapshot>,
    /// `observedAt`; `None` falls back to `Date.now()`, which is `device_now`.
    pub observed_at: Option<f64>,
    /// The device clock, `Date.now()`.
    pub device_now: f64,
}

/// Port of `buildHeartbeatRequest`. Errors with `Invalid time value` (a
/// `RangeError` in JavaScript) when the checkpoint time is not a valid date.
pub fn build_heartbeat_request(
    args: &HeartbeatArgs<'_>,
) -> Result<HeartbeatRequest, InvalidTimeValue> {
    let state = agent_state_from_timer(args.timer_status);
    let (timer_checkpoint, active_entry_id) = match args.timer_status {
        TimerStatus::Running {
            entry_id, revision, ..
        } => (
            Some(TimerCheckpoint {
                entry_id: entry_id.clone(),
                revision: max(1.0, *revision),
                state,
                observed_at: to_iso_string(args.observed_at.unwrap_or(args.device_now))?,
            }),
            Some(entry_id.clone()),
        ),
        TimerStatus::Idle { .. } => (None, None),
    };
    Ok(HeartbeatRequest {
        agent_version: args.agent_version.to_owned(),
        platform: args.platform,
        state,
        active_entry_id,
        tracking_protocol_version: TIMER_TRACKING_PROTOCOL_VERSION,
        timer_checkpoint,
        permissions: args.permissions,
        startup: args.startup,
    })
}
