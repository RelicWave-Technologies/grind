//! Port of `legacy/agent/src/main/services/updates/state.ts`: the pure
//! update-status reducer, semver comparison and retry delays.

use serde::{Deserialize, Serialize};

use crate::js::number::{max, min, strict_eq};

mod version;

pub use version::{compare_versions, is_version_newer};

/// `UpdateChannel`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateChannel {
    Latest,
    Beta,
}

/// `UpdatePhase`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UpdatePhase {
    Idle,
    Checking,
    Available,
    Downloading,
    Ready,
    Installing,
    NotAvailable,
    Error,
}

/// Port of `UpdateStatus`. Field order is the TypeScript literal's.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub phase: UpdatePhase,
    pub enabled: bool,
    pub current_version: String,
    pub channel: UpdateChannel,
    pub available_version: Option<String>,
    pub percent: Option<f64>,
    pub error: Option<String>,
    pub checked_at: Option<f64>,
    pub ready_at: Option<f64>,
    pub manual: bool,
    pub can_install_now: bool,
}

/// `TimerInstallState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(tag = "state")]
pub enum TimerInstallState {
    #[serde(rename = "IDLE")]
    Idle,
    #[serde(rename = "RUNNING")]
    Running { paused: bool },
}

/// Port of `UpdateEvent`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum UpdateEvent {
    Checking {
        manual: bool,
        at: f64,
    },
    Available {
        version: Option<String>,
    },
    DownloadProgress {
        percent: f64,
    },
    Downloaded {
        version: Option<String>,
        can_install_now: bool,
        at: f64,
    },
    Installing {
        at: f64,
    },
    NotAvailable {
        manual: bool,
        at: f64,
    },
    Error {
        message: String,
        manual: bool,
        at: f64,
    },
    TimerChanged {
        can_install_now: bool,
    },
}

/// Port of `initialUpdateStatus`; `can_install_now` defaults to `true`.
#[must_use]
pub fn initial_update_status(
    enabled: bool,
    current_version: &str,
    channel: UpdateChannel,
    can_install_now: Option<bool>,
) -> UpdateStatus {
    UpdateStatus {
        phase: UpdatePhase::Idle,
        enabled,
        current_version: current_version.to_owned(),
        channel,
        available_version: None,
        percent: None,
        error: None,
        checked_at: None,
        ready_at: None,
        manual: false,
        can_install_now: can_install_now.unwrap_or(true),
    }
}

/// Port of `canInstallUpdate`.
#[must_use]
pub fn can_install_update(timer: &TimerInstallState) -> bool {
    matches!(timer, TimerInstallState::Idle)
}

/// Port of `nextRetryDelayMs`.
#[must_use]
pub fn next_retry_delay_ms(automatic_error_count: f64) -> Option<f64> {
    if automatic_error_count <= 1.0 {
        Some(900_000.0)
    } else if strict_eq(automatic_error_count, 2.0) {
        Some(3_600_000.0)
    } else {
        None
    }
}

/// Port of `applyUpdateEvent`.
#[must_use]
pub fn apply_update_event(status: &UpdateStatus, event: &UpdateEvent) -> UpdateStatus {
    let mut next = status.clone();
    match event {
        UpdateEvent::Checking { manual, .. } => {
            next.phase = UpdatePhase::Checking;
            next.percent = None;
            next.error = None;
            next.manual = *manual;
        }
        UpdateEvent::Available { version } => {
            apply_available(&mut next, status, version.as_deref());
        }
        UpdateEvent::DownloadProgress { percent } => {
            next.phase = UpdatePhase::Downloading;
            next.percent = Some(max(0.0, min(100.0, *percent)));
            next.error = None;
        }
        UpdateEvent::Downloaded {
            version,
            can_install_now,
            at,
        } => {
            return apply_downloaded(status, version.as_deref(), *can_install_now, *at);
        }
        UpdateEvent::Installing { at } => {
            next.phase = UpdatePhase::Installing;
            next.percent = Some(100.0);
            next.error = None;
            next.checked_at = Some(*at);
            next.manual = true;
        }
        UpdateEvent::NotAvailable { .. } | UpdateEvent::Error { .. } => {
            apply_settled(&mut next, event);
        }
        UpdateEvent::TimerChanged { can_install_now } => next.can_install_now = *can_install_now,
    }
    next
}

/// The two events that end a check without a download: up to date, or failed.
fn apply_settled(next: &mut UpdateStatus, event: &UpdateEvent) {
    match event {
        UpdateEvent::NotAvailable { manual, at } => {
            next.phase = UpdatePhase::NotAvailable;
            next.available_version = None;
            next.percent = None;
            next.error = None;
            next.checked_at = Some(*at);
            next.manual = *manual;
        }
        UpdateEvent::Error {
            message,
            manual,
            at,
        } => {
            next.phase = UpdatePhase::Error;
            next.error = Some(message.clone());
            next.checked_at = Some(*at);
            next.manual = *manual;
        }
        _ => {}
    }
}

fn apply_available(next: &mut UpdateStatus, status: &UpdateStatus, version: Option<&str>) {
    if is_version_newer(&status.current_version, version) {
        next.phase = UpdatePhase::Available;
        next.available_version = version
            .map(str::to_owned)
            .or_else(|| status.available_version.clone());
        next.percent = Some(0.0);
    } else {
        next.phase = UpdatePhase::NotAvailable;
        next.available_version = None;
        next.percent = None;
    }
    next.error = None;
}

fn apply_downloaded(
    status: &UpdateStatus,
    version: Option<&str>,
    can_install_now: bool,
    at: f64,
) -> UpdateStatus {
    let mut next = status.clone();
    next.error = None;
    next.checked_at = Some(at);
    if is_version_newer(&status.current_version, version) {
        next.phase = UpdatePhase::Ready;
        next.available_version = version
            .map(str::to_owned)
            .or_else(|| status.available_version.clone());
        next.percent = Some(100.0);
        next.ready_at = Some(at);
        next.can_install_now = can_install_now;
    } else {
        next.phase = UpdatePhase::NotAvailable;
        next.available_version = None;
        next.percent = None;
        next.ready_at = None;
    }
    next
}
