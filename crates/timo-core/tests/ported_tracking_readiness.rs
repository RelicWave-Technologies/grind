//! 1:1 port of `trackingReadiness.test.ts`
//! (legacy/agent/src/main/services/trackingReadiness.test.ts).
#![cfg(test)]

use timo_core::desktop_types::{CaptureHealth, ScreenStatus};
use timo_core::tracking_readiness::{
    ActivityCaptureStatus, BlockingCapability, CapabilityState, Inspect, ReadinessInspection,
    Readings, SystemIdleState, TrackingBlockedError, TrackingReadinessService,
    is_inconclusive_screen_capture,
};

const NOW: f64 = 1_700_000_000_000.0;

fn accessibility(patch: impl FnOnce(&mut ActivityCaptureStatus)) -> ActivityCaptureStatus {
    let mut status = ActivityCaptureStatus {
        trusted: true,
        ready: true,
        recording: false,
        capturing: false,
        hook_running: false,
        last_hook_error: None,
    };
    patch(&mut status);
    status
}

/// The test's `setup(opts)`: a service over fixed readings and a counted probe.
struct Setup {
    service: TrackingReadinessService,
    darwin: bool,
    screen_status: ScreenStatus,
    screen_health: CaptureHealth,
    accessibility: ActivityCaptureStatus,
    probe_health: CaptureHealth,
    probe_calls: usize,
}

fn setup() -> Setup {
    Setup {
        service: TrackingReadinessService::new(),
        darwin: true,
        screen_status: ScreenStatus::Granted,
        screen_health: CaptureHealth::Unknown,
        accessibility: accessibility(|_| {}),
        probe_health: CaptureHealth::Ok,
        probe_calls: 0,
    }
}

impl Setup {
    /// `await service.inspect({ verifyScreen })`.
    fn inspect(&mut self, verify_screen: bool) -> ReadinessInspection {
        let readings = Readings {
            darwin: self.darwin,
            screen_status: self.screen_status,
            screen_health: self.screen_health,
            accessibility: self.accessibility.clone(),
        };
        match self.service.begin_inspect(verify_screen, readings, NOW) {
            Inspect::Done(result) => result.unwrap(),
            Inspect::NeedsProbe(pending) => {
                self.probe_calls += 1;
                self.service
                    .finish_inspect(&pending, self.probe_health, NOW)
                    .unwrap()
            }
        }
    }

    /// `await service.assertCanAccrue()`.
    fn assert_can_accrue(&mut self) -> Result<(), TrackingBlockedError> {
        let inspection = self.inspect(true);
        TrackingReadinessService::assert_can_accrue(&inspection)
    }
}

mod tracking_readiness_service {
    use super::*;

    #[test]
    fn treats_macos_capabilities_as_ready_only_after_a_real_screen_probe() {
        let mut s = setup();

        let result = s.inspect(true);

        assert_eq!(s.probe_calls, 1);
        assert!(result.readiness.ready);
        assert_eq!(result.readiness.screen_recording, CapabilityState::Ready);
        assert_eq!(result.readiness.accessibility, CapabilityState::Ready);
        assert!(result.readiness.blocking_capabilities.is_empty());
    }

    #[test]
    fn does_not_trigger_the_native_screen_prompt_during_a_passive_status_check() {
        let mut s = setup();
        s.screen_status = ScreenStatus::NotDetermined;

        let result = s.inspect(true);

        assert_eq!(s.probe_calls, 0);
        assert!(!result.readiness.ready);
        assert_eq!(
            result.readiness.screen_recording,
            CapabilityState::NeedsGrant
        );
        assert_eq!(
            result.readiness.blocking_capabilities,
            vec![BlockingCapability::ScreenRecording]
        );
    }

    #[test]
    fn maps_denied_screen_access_to_system_settings_and_a_failed_effective_grant_to_restart() {
        let mut denied = setup();
        denied.screen_status = ScreenStatus::Denied;
        denied.screen_health = CaptureHealth::NoPermission;
        let mut ineffective = setup();
        ineffective.screen_status = ScreenStatus::Granted;
        ineffective.screen_health = CaptureHealth::Error;
        ineffective.probe_health = CaptureHealth::Error;

        assert_eq!(
            denied.inspect(false).readiness.screen_recording,
            CapabilityState::NeedsSettings
        );
        assert_eq!(
            ineffective.inspect(true).readiness.screen_recording,
            CapabilityState::NeedsRestart
        );
    }

    #[test]
    fn requires_accessibility_trust_and_an_initialized_native_activity_service() {
        let mut untrusted = setup();
        untrusted.accessibility = accessibility(|a| a.trusted = false);
        let mut restart = setup();
        restart.accessibility = accessibility(|a| a.ready = false);
        let mut failed = setup();
        failed.accessibility =
            accessibility(|a| a.last_hook_error = Some("native hook denied".to_owned()));

        assert_eq!(
            untrusted.inspect(true).readiness.accessibility,
            CapabilityState::NeedsGrant
        );
        assert_eq!(
            restart.inspect(true).readiness.accessibility,
            CapabilityState::NeedsRestart
        );
        assert_eq!(
            failed.inspect(true).readiness.accessibility,
            CapabilityState::Failed
        );
    }

    #[test]
    fn blocks_accrual_with_a_typed_serializable_readiness_payload() {
        let mut s = setup();
        s.screen_status = ScreenStatus::Denied;

        let error = s.assert_can_accrue().unwrap_err();
        assert_eq!(TrackingBlockedError::CODE, "TRACKING_PERMISSIONS_REQUIRED");
        assert_eq!(
            error.readiness.blocking_capabilities,
            vec![BlockingCapability::ScreenRecording]
        );
        // A second attempt rejects the same way.
        assert!(s.assert_can_accrue().is_err());
    }

    #[test]
    fn marks_macos_only_capabilities_not_required_on_windows_without_probing() {
        let mut s = setup();
        s.darwin = false;
        s.screen_status = ScreenStatus::Denied;
        s.accessibility = accessibility(|a| {
            a.trusted = false;
            a.ready = false;
        });

        let result = s.inspect(true);

        assert_eq!(s.probe_calls, 0);
        assert!(result.readiness.ready);
        assert_eq!(result.readiness.checked_at, "2023-11-14T22:13:20.000Z");
        assert_eq!(
            result.readiness.screen_recording,
            CapabilityState::NotRequired
        );
        assert_eq!(result.readiness.accessibility, CapabilityState::NotRequired);
        assert!(result.readiness.blocking_capabilities.is_empty());
    }
}

mod is_inconclusive_screen_capture_ {
    use super::*;

    fn empty_capture() -> Setup {
        let mut s = setup();
        s.screen_health = CaptureHealth::Empty;
        s.probe_health = CaptureHealth::Empty;
        s
    }

    #[test]
    fn holds_the_verdict_for_empty_captures_while_the_user_is_not_active() {
        let mut s = empty_capture();
        let inspection = s.inspect(true);

        assert_eq!(
            inspection.readiness.blocking_capabilities,
            vec![BlockingCapability::ScreenRecording]
        );
        assert!(is_inconclusive_screen_capture(
            &inspection,
            SystemIdleState::Idle
        ));
        assert!(is_inconclusive_screen_capture(
            &inspection,
            SystemIdleState::Locked
        ));
        assert!(is_inconclusive_screen_capture(
            &inspection,
            SystemIdleState::Unknown
        ));
    }

    #[test]
    fn treats_empty_captures_during_active_use_as_a_real_failure() {
        let mut s = empty_capture();
        let inspection = s.inspect(true);

        assert!(!is_inconclusive_screen_capture(
            &inspection,
            SystemIdleState::Active
        ));
    }

    #[test]
    fn never_masks_a_revoked_permission_or_an_accessibility_failure() {
        let mut denied = setup();
        denied.screen_status = ScreenStatus::Denied;
        assert!(!is_inconclusive_screen_capture(
            &denied.inspect(false),
            SystemIdleState::Idle
        ));

        let mut two_blockers = empty_capture();
        two_blockers.accessibility = accessibility(|a| a.trusted = false);
        assert!(!is_inconclusive_screen_capture(
            &two_blockers.inspect(true),
            SystemIdleState::Idle
        ));
    }
}
