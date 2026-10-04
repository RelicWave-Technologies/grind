//! Port of `legacy/agent/src/main/services/trackingReadiness.ts`: whether the
//! machine may accrue tracked time (screen recording and accessibility), with
//! every dependency injected.
//!
//! The TypeScript `inspect` is `async` only because it may await one screen
//! probe. Here that await is the seam: [`TrackingReadinessService::begin_inspect`]
//! runs everything up to it and either finishes or returns a
//! [`PendingInspect`]; [`TrackingReadinessService::finish_inspect`] is the
//! continuation. The readings taken before the await stay frozen in the pending
//! value (the TypeScript reads each dependency once), while the probe memo is
//! read again afterwards, so an event that lands in between (`noteScreenHealth`,
//! `invalidateScreenProbe`) is seen exactly as in JavaScript.

use serde::Deserialize;

use crate::desktop_types::{
    AccessibilityPermission, CaptureHealth, DesktopPermissionSnapshot, ScreenPermission,
    ScreenStatus, screen_ui_state,
};
use crate::js::iso::{InvalidTimeValue, to_iso_string};

mod types;

pub use types::{
    ActivityCaptureStatus, BlockingCapability, CapabilityState, Inspect, PendingInspect,
    ReadinessInspection, Readings, TrackingBlockedError, TrackingReadiness, VerdictLog,
};

/// Port of `screenCapability`.
fn screen_capability(
    status: ScreenStatus,
    health: CaptureHealth,
    probe_healthy: Option<bool>,
) -> CapabilityState {
    match status {
        ScreenStatus::NotDetermined | ScreenStatus::Unknown => return CapabilityState::NeedsGrant,
        ScreenStatus::Denied | ScreenStatus::Restricted => return CapabilityState::NeedsSettings,
        ScreenStatus::Granted => {}
    }
    if probe_healthy == Some(true) || health == CaptureHealth::Ok {
        return CapabilityState::Ready;
    }
    if probe_healthy == Some(false)
        || matches!(
            health,
            CaptureHealth::Empty | CaptureHealth::Error | CaptureHealth::NoPermission
        )
    {
        return CapabilityState::NeedsRestart;
    }
    // Granted, nothing has failed, and no probe has run yet: "not known", not
    // "broken".
    CapabilityState::Checking
}

/// Port of `accessibilityCapability`.
fn accessibility_capability(status: &ActivityCaptureStatus) -> CapabilityState {
    if !status.trusted {
        CapabilityState::NeedsGrant
    } else if !status.ready {
        CapabilityState::NeedsRestart
    } else if status
        .last_hook_error
        .as_deref()
        .is_some_and(|e| !e.is_empty())
    {
        CapabilityState::Failed
    } else {
        CapabilityState::Ready
    }
}

/// `SystemIdleState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SystemIdleState {
    Active,
    Idle,
    Locked,
    Unknown,
}

/// Port of `isInconclusiveScreenCapture`: an unhealthy inspection explainable by
/// a display that is not rendering rather than by a lost permission.
#[must_use]
pub fn is_inconclusive_screen_capture(
    inspection: &ReadinessInspection,
    idle_state: SystemIdleState,
) -> bool {
    if idle_state == SystemIdleState::Active {
        return false;
    }
    inspection.readiness.blocking_capabilities == [BlockingCapability::ScreenRecording]
        && inspection.permissions.screen.status == ScreenStatus::Granted
        && inspection.permissions.screen.health == CaptureHealth::Empty
}

/// Port of `createTrackingReadinessService`.
#[derive(Debug, Default)]
pub struct TrackingReadinessService {
    screen_probe_healthy: Option<bool>,
    last_verdict: Option<VerdictLog>,
    logs: Vec<VerdictLog>,
}

impl TrackingReadinessService {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// The warnings logged since the last call (`log.warn('tracking readiness
    /// not ready', fields)`), oldest first.
    pub fn take_logs(&mut self) -> Vec<VerdictLog> {
        std::mem::take(&mut self.logs)
    }

    /// `inspect({ verifyScreen })` up to the optional probe. `now` is
    /// `deps.now()`, read when the readiness is built.
    pub fn begin_inspect(&mut self, verify_screen: bool, readings: Readings, now: f64) -> Inspect {
        if !readings.darwin {
            return Inspect::Done(Self::inspect_other_platform(&readings, now));
        }
        if readings.screen_health == CaptureHealth::Ok {
            self.screen_probe_healthy = Some(true);
        }
        if readings.screen_status != ScreenStatus::Granted {
            self.screen_probe_healthy = Some(false);
        }
        if verify_screen
            && readings.screen_status == ScreenStatus::Granted
            && self.screen_probe_healthy != Some(true)
        {
            return Inspect::NeedsProbe(PendingInspect { readings });
        }
        Inspect::Done(self.build_darwin(&readings, readings.screen_health, now))
    }

    /// The continuation after `await deps.probeScreen()`.
    pub fn finish_inspect(
        &mut self,
        pending: &PendingInspect,
        probed: CaptureHealth,
        now: f64,
    ) -> Result<ReadinessInspection, InvalidTimeValue> {
        self.screen_probe_healthy = Some(probed == CaptureHealth::Ok);
        self.build_darwin(&pending.readings, probed, now)
    }

    /// `assertCanAccrue()` given the inspection it awaited.
    pub fn assert_can_accrue(inspection: &ReadinessInspection) -> Result<(), TrackingBlockedError> {
        if inspection.readiness.ready {
            Ok(())
        } else {
            Err(TrackingBlockedError {
                readiness: inspection.readiness.clone(),
            })
        }
    }

    /// `requestScreenAccess()` after `await deps.probeScreen()` returned
    /// `health`: remembers the probe, then inspects again (which may probe once
    /// more).
    pub fn note_requested_probe(&mut self, health: CaptureHealth) {
        self.screen_probe_healthy = Some(health == CaptureHealth::Ok);
    }

    /// `noteScreenHealth(health)`.
    pub fn note_screen_health(&mut self, health: CaptureHealth) {
        if health == CaptureHealth::Ok {
            self.screen_probe_healthy = Some(true);
        } else if health != CaptureHealth::Unknown {
            self.screen_probe_healthy = Some(false);
        }
    }

    /// `invalidateScreenProbe()`.
    pub fn invalidate_screen_probe(&mut self) {
        self.screen_probe_healthy = None;
    }

    fn inspect_other_platform(
        readings: &Readings,
        now: f64,
    ) -> Result<ReadinessInspection, InvalidTimeValue> {
        let a = &readings.accessibility;
        Ok(ReadinessInspection {
            readiness: TrackingReadiness {
                ready: true,
                checked_at: to_iso_string(now)?,
                screen_recording: CapabilityState::NotRequired,
                accessibility: CapabilityState::NotRequired,
                blocking_capabilities: Vec::new(),
            },
            permissions: DesktopPermissionSnapshot {
                screen: ScreenPermission {
                    status: ScreenStatus::Granted,
                    health: CaptureHealth::Ok,
                    state: crate::desktop_types::ScreenUiState::Ok,
                },
                accessibility: AccessibilityPermission {
                    trusted: true,
                    ready: true,
                    recording: a.recording,
                    capturing: a.capturing,
                    hook_running: a.hook_running,
                },
            },
            accessibility_error: None,
        })
    }

    fn build_darwin(
        &mut self,
        readings: &Readings,
        raw_screen_health: CaptureHealth,
        now: f64,
    ) -> Result<ReadinessInspection, InvalidTimeValue> {
        let status = readings.screen_status;
        let a = &readings.accessibility;
        let screen_recording =
            screen_capability(status, raw_screen_health, self.screen_probe_healthy);
        let accessibility = accessibility_capability(a);
        let effective_health = if self.screen_probe_healthy == Some(true) {
            CaptureHealth::Ok
        } else {
            raw_screen_health
        };
        let mut blocking = Vec::new();
        if screen_recording != CapabilityState::Ready {
            blocking.push(BlockingCapability::ScreenRecording);
        }
        if accessibility != CapabilityState::Ready {
            blocking.push(BlockingCapability::Accessibility);
        }
        if !blocking.is_empty() {
            self.log_verdict(VerdictLog {
                screen_recording,
                accessibility,
                screen_status: status,
                screen_health: effective_health,
                screen_probe_healthy: self.screen_probe_healthy,
                accessibility_trusted: a.trusted,
                accessibility_ready: a.ready,
                hook_running: a.hook_running,
                last_hook_error: a.last_hook_error.clone(),
            });
        }
        let readiness = TrackingReadiness {
            ready: blocking.is_empty(),
            checked_at: to_iso_string(now)?,
            screen_recording,
            accessibility,
            blocking_capabilities: blocking,
        };
        Ok(ReadinessInspection {
            readiness,
            permissions: Self::snapshot(readings, effective_health),
            accessibility_error: a.last_hook_error.clone(),
        })
    }

    /// The `permissions` snapshot of a macOS inspection.
    fn snapshot(readings: &Readings, effective_health: CaptureHealth) -> DesktopPermissionSnapshot {
        let status = readings.screen_status;
        let a = &readings.accessibility;
        DesktopPermissionSnapshot {
            screen: ScreenPermission {
                status,
                health: effective_health,
                state: screen_ui_state(status, effective_health),
            },
            accessibility: AccessibilityPermission {
                trusted: a.trusted,
                ready: a.ready,
                recording: a.recording,
                capturing: a.capturing,
                hook_running: a.hook_running,
            },
        }
    }

    /// Log a non-ready verdict at most once per distinct shape.
    fn log_verdict(&mut self, fields: VerdictLog) {
        if self.last_verdict.as_ref() == Some(&fields) {
            return;
        }
        self.last_verdict = Some(fields.clone());
        self.logs.push(fields);
    }
}
