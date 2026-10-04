//! The data types of the tracking-readiness service.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::js::iso::InvalidTimeValue;

use crate::desktop_types::{CaptureHealth, DesktopPermissionSnapshot, ScreenStatus};

/// `CapabilityState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CapabilityState {
    #[serde(rename = "NOT_REQUIRED")]
    NotRequired,
    #[serde(rename = "READY")]
    Ready,
    #[serde(rename = "CHECKING")]
    Checking,
    #[serde(rename = "NEEDS_GRANT")]
    NeedsGrant,
    #[serde(rename = "NEEDS_SETTINGS")]
    NeedsSettings,
    #[serde(rename = "NEEDS_RESTART")]
    NeedsRestart,
    #[serde(rename = "FAILED")]
    Failed,
}

/// `BlockingCapability`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BlockingCapability {
    #[serde(rename = "SCREEN_RECORDING")]
    ScreenRecording,
    #[serde(rename = "ACCESSIBILITY")]
    Accessibility,
}

/// `TrackingReadiness` (`shared/tracking.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackingReadiness {
    pub ready: bool,
    pub checked_at: String,
    pub screen_recording: CapabilityState,
    pub accessibility: CapabilityState,
    pub blocking_capabilities: Vec<BlockingCapability>,
}

/// `ActivityCaptureStatus` (`activity/index.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(
    clippy::struct_excessive_bools,
    reason = "mirrors the TypeScript status object's five independent flags"
)]
pub struct ActivityCaptureStatus {
    pub trusted: bool,
    pub ready: bool,
    pub recording: bool,
    pub capturing: bool,
    pub hook_running: bool,
    pub last_hook_error: Option<String>,
}

/// `ReadinessInspection`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadinessInspection {
    pub readiness: TrackingReadiness,
    pub permissions: DesktopPermissionSnapshot,
    pub accessibility_error: Option<String>,
}

/// The readings one `inspect` takes from its dependencies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Readings {
    /// `deps.platform === 'darwin'`.
    pub darwin: bool,
    /// `deps.screenStatus()`.
    pub screen_status: ScreenStatus,
    /// `deps.screenHealth()`.
    pub screen_health: CaptureHealth,
    /// `deps.accessibilityStatus()`.
    pub accessibility: ActivityCaptureStatus,
}

/// `TrackingBlockedError`: carries the readiness that blocked accrual.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
#[error("Tracking permissions are required")]
pub struct TrackingBlockedError {
    /// `code`, always `TRACKING_PERMISSIONS_REQUIRED`.
    pub readiness: TrackingReadiness,
}

impl TrackingBlockedError {
    /// `error.code`.
    pub const CODE: &'static str = "TRACKING_PERMISSIONS_REQUIRED";
}

/// The `fields` of the "tracking readiness not ready" warning.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerdictLog {
    pub screen_recording: CapabilityState,
    pub accessibility: CapabilityState,
    pub screen_status: ScreenStatus,
    pub screen_health: CaptureHealth,
    pub screen_probe_healthy: Option<bool>,
    pub accessibility_trusted: bool,
    pub accessibility_ready: bool,
    pub hook_running: bool,
    pub last_hook_error: Option<String>,
}

/// An `inspect` waiting for its screen probe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingInspect {
    pub(super) readings: Readings,
}

/// Where `begin_inspect` got to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Inspect {
    Done(Result<ReadinessInspection, InvalidTimeValue>),
    /// The service wants `deps.probeScreen()`; finish with its health.
    NeedsProbe(PendingInspect),
}
