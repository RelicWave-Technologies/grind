//! 1:1 ports of the small desktop service tests: `promptReachability.test.ts`,
//! `floatingBarVisibility.test.ts`, `moveToApplications.test.ts`,
//! `trayPresentation.test.ts`, `heartbeatPayload.test.ts`, `updates/state.test.ts`,
//! `windows/floatingBarPosition.test.ts` and the placement tests of
//! `windows/overlay.test.ts`.
#![cfg(test)]
#![allow(
    clippy::float_cmp,
    clippy::float_arithmetic,
    clippy::indexing_slicing,
    reason = "the ported tests compare the exact doubles the TypeScript tests compare"
)]

use timo_core::desktop_types::{
    AccessibilityPermission, AgentState, CaptureHealth, DesktopPermissionSnapshot,
    LaunchAtLoginSnapshot, LaunchAtLoginState, LaunchOrigin, Platform, ScreenPermission,
    ScreenStatus, ScreenUiState, TimerPauseReason, TimerStatus,
};
use timo_core::floating_bar_position::{
    EDGE_MARGIN, default_corner, is_visible_enough, resolve_position,
};
use timo_core::floating_bar_visibility::FloatingBarVisibilityPolicy;
use timo_core::heartbeat_payload::{
    HeartbeatArgs, agent_state_from_timer, build_heartbeat_request, current_platform,
};
use timo_core::move_to_applications::{
    MoveRefusal, MoveThrew, MoveToApplicationsDeps, MoveToApplicationsResult, move_to_applications,
};
use timo_core::placement::{
    Point, Rect, Size, bottom_right, center, top_right, tray_popover_point,
};
use timo_core::prompt_reachability::{
    PROMPT_UNREACHABLE_WINDOW_MS, PromptGateDecision, PromptGateInput, decide_prompt_gate,
};
use timo_core::tray_presentation::{tray_menu_title_for_elapsed, tray_tooltip_for_elapsed};
use timo_core::updates_state::{
    TimerInstallState, UpdateChannel, UpdateEvent, UpdatePhase, apply_update_event,
    can_install_update, initial_update_status, is_version_newer, next_retry_delay_ms,
};

mod decide_prompt_gate_ {
    use super::*;

    const BASE: PromptGateInput = PromptGateInput {
        has_prompt: true,
        since_last_restore_ms: None,
        window_ms: PROMPT_UNREACHABLE_WINDOW_MS,
    };

    fn gate(patch: impl FnOnce(&mut PromptGateInput)) -> PromptGateDecision {
        let mut input = BASE;
        patch(&mut input);
        decide_prompt_gate(&input)
    }

    #[test]
    fn opens_the_window_when_no_prompt_is_in_the_way() {
        assert_eq!(
            gate(|i| i.has_prompt = false),
            PromptGateDecision::ShowWindow
        );
    }

    #[test]
    fn opens_the_window_even_if_a_restore_happened_moments_ago_when_nothing_is_active() {
        assert_eq!(
            gate(|i| {
                i.has_prompt = false;
                i.since_last_restore_ms = Some(10.0);
            }),
            PromptGateDecision::ShowWindow
        );
    }

    #[test]
    fn restores_the_prompt_on_the_first_ask() {
        assert_eq!(gate(|_| {}), PromptGateDecision::RestorePrompt);
    }

    #[test]
    fn releases_when_the_person_asks_again_straight_away() {
        assert_eq!(
            gate(|i| i.since_last_restore_ms = Some(800.0)),
            PromptGateDecision::ReleaseAndShow
        );
    }

    #[test]
    fn still_releases_just_inside_the_window() {
        assert_eq!(
            gate(|i| i.since_last_restore_ms = Some(PROMPT_UNREACHABLE_WINDOW_MS - 1.0)),
            PromptGateDecision::ReleaseAndShow
        );
    }

    #[test]
    fn treats_an_ask_exactly_on_the_boundary_as_a_fresh_one() {
        assert_eq!(
            gate(|i| i.since_last_restore_ms = Some(PROMPT_UNREACHABLE_WINDOW_MS)),
            PromptGateDecision::RestorePrompt
        );
    }

    #[test]
    fn does_not_release_for_two_deliberate_clicks_minutes_apart() {
        assert_eq!(
            gate(|i| i.since_last_restore_ms = Some(5.0 * 60_000.0)),
            PromptGateDecision::RestorePrompt
        );
    }

    #[test]
    fn treats_a_backwards_clock_as_a_fresh_ask_rather_than_a_repeat() {
        // A device clock correction must never silently dismiss somebody's prompt.
        assert_eq!(
            gate(|i| i.since_last_restore_ms = Some(-4_000.0)),
            PromptGateDecision::RestorePrompt
        );
    }

    #[test]
    fn honours_a_custom_window() {
        assert_eq!(
            gate(|i| {
                i.since_last_restore_ms = Some(3_000.0);
                i.window_ms = 1_000.0;
            }),
            PromptGateDecision::RestorePrompt
        );
        assert_eq!(
            gate(|i| {
                i.since_last_restore_ms = Some(500.0);
                i.window_ms = 1_000.0;
            }),
            PromptGateDecision::ReleaseAndShow
        );
    }
}

mod floating_bar_visibility_policy {
    use super::*;

    #[test]
    fn stays_visible_while_the_same_entry_changes_from_accruing_to_paused() {
        let mut policy = FloatingBarVisibilityPolicy::new();

        assert!(policy.sync_timer(Some("entry-1"), true));
        assert!(policy.sync_timer(Some("entry-1"), true));
    }

    #[test]
    fn dismisses_only_the_current_entry_and_restores_for_the_next_entry() {
        let mut policy = FloatingBarVisibilityPolicy::new();

        assert!(policy.sync_timer(Some("entry-1"), true));
        assert!(!policy.dismiss_current());
        assert!(!policy.sync_timer(Some("entry-1"), true));
        assert!(!policy.sync_timer(None, true));
        assert!(policy.sync_timer(Some("entry-2"), true));
    }

    #[test]
    fn keeps_the_settings_preference_authoritative_and_lets_explicit_enable_restore_the_bar() {
        let mut policy = FloatingBarVisibilityPolicy::new();

        assert!(!policy.sync_timer(Some("entry-1"), false));
        assert!(policy.set_preference_visible(true));
        assert!(!policy.dismiss_current());
        assert!(policy.set_preference_visible(true));
        assert!(!policy.set_preference_visible(false));
    }
}

mod move_to_applications_coordinator {
    use super::*;
    use std::task::{Context, Poll, Waker};

    /// Runs a future that never really waits (every dependency resolves at once).
    fn block_on<F: Future>(future: F) -> F::Output {
        let mut future = std::pin::pin!(future);
        let mut cx = Context::from_waker(Waker::noop());
        loop {
            if let Poll::Ready(value) = future.as_mut().poll(&mut cx) {
                return value;
            }
        }
    }

    struct Deps {
        tracking: bool,
        confirm: bool,
        moved: Result<bool, MoveThrew>,
        confirm_calls: usize,
        cleanup_calls: usize,
        move_calls: usize,
        invalidate_calls: usize,
    }

    fn deps() -> Deps {
        Deps {
            tracking: false,
            confirm: true,
            moved: Ok(true),
            confirm_calls: 0,
            cleanup_calls: 0,
            move_calls: 0,
            invalidate_calls: 0,
        }
    }

    impl MoveToApplicationsDeps for Deps {
        fn is_tracking(&mut self) -> bool {
            self.tracking
        }
        async fn confirm(&mut self) -> bool {
            self.confirm_calls += 1;
            self.confirm
        }
        async fn cleanup(&mut self) {
            self.cleanup_calls += 1;
        }
        fn move_app(&mut self) -> Result<bool, MoveThrew> {
            self.move_calls += 1;
            self.moved
        }
        fn invalidate_cleanup(&mut self) {
            self.invalidate_calls += 1;
        }
    }

    fn refused(reason: MoveRefusal) -> MoveToApplicationsResult {
        use timo_core::move_to_applications::MoveRefused;
        MoveToApplicationsResult::Refused(MoveRefused { ok: false, reason })
    }

    #[test]
    fn blocks_an_active_timer_before_confirmation_or_cleanup() {
        let mut d = deps();
        d.tracking = true;

        assert_eq!(
            block_on(move_to_applications(&mut d)),
            refused(MoveRefusal::TrackingActive)
        );
        assert_eq!(d.confirm_calls, 0);
        assert_eq!(d.cleanup_calls, 0);
        assert_eq!(d.move_calls, 0);
    }

    #[test]
    fn does_not_clean_up_when_the_user_cancels_confirmation() {
        let mut d = deps();
        d.confirm = false;

        assert_eq!(
            block_on(move_to_applications(&mut d)),
            refused(MoveRefusal::Cancelled)
        );
        assert_eq!(d.cleanup_calls, 0);
        assert_eq!(d.move_calls, 0);
    }

    #[test]
    fn invalidates_early_cleanup_when_an_electron_conflict_is_cancelled() {
        let mut d = deps();
        d.moved = Ok(false);

        assert_eq!(
            block_on(move_to_applications(&mut d)),
            refused(MoveRefusal::Cancelled)
        );
        assert_eq!(d.cleanup_calls, 1);
        assert_eq!(d.invalidate_calls, 1);
    }

    #[test]
    fn invalidates_early_cleanup_when_the_move_fails() {
        let mut d = deps();
        d.moved = Err(MoveThrew);

        assert_eq!(
            block_on(move_to_applications(&mut d)),
            refused(MoveRefusal::MoveFailed)
        );
        assert_eq!(d.invalidate_calls, 1);
    }
}

mod tray_presentation {
    use super::*;

    #[test]
    fn keeps_the_stopped_menu_bar_item_icon_sized() {
        assert_eq!(tray_menu_title_for_elapsed(None, None), "");
        assert_eq!(tray_menu_title_for_elapsed(Some(""), None), "");
        assert_eq!(tray_tooltip_for_elapsed(None), "Timo");
    }

    #[test]
    fn shows_the_shortest_running_elapsed_title_while_the_tooltip_keeps_app_identity() {
        assert_eq!(tray_menu_title_for_elapsed(Some("00:42"), None), " 00:42");
        assert_eq!(tray_tooltip_for_elapsed(Some("00:42")), "Timo 00:42");
    }

    #[test]
    fn falls_back_to_visible_text_if_the_tray_icon_cannot_load() {
        assert_eq!(tray_menu_title_for_elapsed(Some(""), Some(false)), "Timo");
        assert_eq!(
            tray_menu_title_for_elapsed(Some("00:42"), Some(false)),
            "Timo 00:42"
        );
    }
}

mod heartbeat_payload {
    use super::*;

    fn idle() -> TimerStatus {
        TimerStatus::Idle { worked_ms: 0.0 }
    }

    #[allow(
        clippy::too_many_arguments,
        reason = "mirrors the fields of the TypeScript status literal"
    )]
    fn running(
        entry_id: &str,
        revision: f64,
        lark_task_guid: Option<&str>,
        segment_started_at: Option<f64>,
        paused: bool,
        pause_reason: Option<TimerPauseReason>,
    ) -> TimerStatus {
        TimerStatus::Running {
            entry_id: entry_id.to_owned(),
            revision,
            lark_task_guid: lark_task_guid.map(str::to_owned),
            started_at: 1.0,
            segment_started_at,
            worked_ms: 10.0,
            paused,
            pause_reason,
        }
    }

    fn build(
        platform: Platform,
        status: &TimerStatus,
        observed_at: Option<f64>,
    ) -> timo_core::heartbeat_payload::HeartbeatRequest {
        build_heartbeat_request(&HeartbeatArgs {
            agent_version: "0.0.2",
            platform,
            timer_status: status,
            permissions: None,
            startup: None,
            observed_at,
            device_now: 1_700_000_000_000.0,
        })
        .unwrap()
    }

    #[test]
    fn maps_idle_timer_status_to_idle_with_no_active_entry() {
        let status = idle();
        assert_eq!(agent_state_from_timer(&status), AgentState::Idle);
        let request = build(Platform::Darwin, &status, None);
        assert_eq!(request.state, AgentState::Idle);
        assert_eq!(request.active_entry_id, None);
    }

    #[test]
    fn maps_accruing_timer_status_to_running() {
        let status = running("entry-1", 7.0, None, Some(1.0), false, None);
        let request = build(Platform::Darwin, &status, Some(1000.0));
        assert_eq!(request.state, AgentState::Running);
        assert_eq!(request.active_entry_id.as_deref(), Some("entry-1"));
        assert_eq!(request.tracking_protocol_version, 2);
        let checkpoint = request.timer_checkpoint.unwrap();
        assert_eq!(checkpoint.entry_id, "entry-1");
        assert_eq!(checkpoint.revision, 7.0);
        assert_eq!(checkpoint.state, AgentState::Running);
        assert_eq!(checkpoint.observed_at, "1970-01-01T00:00:01.000Z");
    }

    #[test]
    fn maps_paused_running_timer_status_to_paused_idle() {
        let status = running(
            "entry-2",
            8.0,
            Some("task"),
            None,
            true,
            Some(TimerPauseReason::Idle),
        );
        let request = build(Platform::Win32, &status, Some(2000.0));
        assert_eq!(request.state, AgentState::PausedIdle);
        assert_eq!(request.active_entry_id.as_deref(), Some("entry-2"));
        let checkpoint = request.timer_checkpoint.unwrap();
        assert_eq!(checkpoint.entry_id, "entry-2");
        assert_eq!(checkpoint.revision, 8.0);
        assert_eq!(checkpoint.state, AgentState::PausedIdle);
        assert_eq!(checkpoint.observed_at, "1970-01-01T00:00:02.000Z");
    }

    #[test]
    fn keeps_an_explicit_user_pause_backward_compatible_as_paused_idle() {
        let status = running(
            "entry-manual",
            9.0,
            Some("task"),
            None,
            true,
            Some(TimerPauseReason::Manual),
        );
        let request = build(Platform::Darwin, &status, None);
        assert_eq!(request.state, AgentState::PausedIdle);
        assert_eq!(request.active_entry_id.as_deref(), Some("entry-manual"));
        assert_eq!(
            request.timer_checkpoint.unwrap().state,
            AgentState::PausedIdle
        );
    }

    #[test]
    fn distinguishes_a_permission_enforced_pause_from_ordinary_idle() {
        let status = running(
            "entry-permission",
            9.0,
            Some("task"),
            None,
            true,
            Some(TimerPauseReason::PermissionRequired),
        );
        let request = build(Platform::Darwin, &status, None);
        assert_eq!(request.state, AgentState::PausedPermission);
        assert_eq!(
            request.timer_checkpoint.unwrap().state,
            AgentState::PausedPermission
        );
    }

    #[test]
    fn includes_the_current_permission_snapshot_when_provided() {
        let status = idle();
        let permissions = DesktopPermissionSnapshot {
            screen: ScreenPermission {
                status: ScreenStatus::Granted,
                health: CaptureHealth::Ok,
                state: ScreenUiState::Ok,
            },
            accessibility: AccessibilityPermission {
                trusted: true,
                ready: true,
                recording: false,
                capturing: false,
                hook_running: false,
            },
        };
        let request = build_heartbeat_request(&HeartbeatArgs {
            agent_version: "0.0.2",
            platform: Platform::Darwin,
            timer_status: &status,
            permissions: Some(permissions),
            startup: None,
            observed_at: None,
            device_now: 0.0,
        })
        .unwrap();
        assert_eq!(request.permissions, Some(permissions));
    }

    #[test]
    fn includes_launch_at_login_health_when_provided() {
        let status = idle();
        let startup = LaunchAtLoginSnapshot {
            state: LaunchAtLoginState::NeedsRepair,
            ready: false,
            opened_at_login: false,
            origin: LaunchOrigin::User,
        };
        let request = build_heartbeat_request(&HeartbeatArgs {
            agent_version: "0.0.2",
            platform: Platform::Win32,
            timer_status: &status,
            permissions: None,
            startup: Some(startup),
            observed_at: None,
            device_now: 0.0,
        })
        .unwrap();
        assert_eq!(request.startup, Some(startup));
    }

    #[test]
    fn normalizes_unknown_node_platforms_to_linux() {
        assert_eq!(current_platform("darwin"), Platform::Darwin);
        assert_eq!(current_platform("win32"), Platform::Win32);
        assert_eq!(current_platform("freebsd"), Platform::Linux);
    }
}

mod update_state_transitions {
    use super::*;

    fn base() -> timo_core::updates_state::UpdateStatus {
        initial_update_status(true, "1.0.0", UpdateChannel::Latest, Some(true))
    }

    #[test]
    fn moves_checking_to_not_available_for_a_manual_up_to_date_check() {
        let checking = apply_update_event(
            &base(),
            &UpdateEvent::Checking {
                manual: true,
                at: 10.0,
            },
        );
        let done = apply_update_event(
            &checking,
            &UpdateEvent::NotAvailable {
                manual: true,
                at: 20.0,
            },
        );

        assert_eq!(done.phase, UpdatePhase::NotAvailable);
        assert!(done.manual);
        assert_eq!(done.checked_at, Some(20.0));
        assert_eq!(done.error, None);
    }

    #[test]
    fn moves_available_through_download_progress_to_ready() {
        let mut s = apply_update_event(
            &base(),
            &UpdateEvent::Checking {
                manual: false,
                at: 10.0,
            },
        );
        s = apply_update_event(
            &s,
            &UpdateEvent::Available {
                version: Some("1.0.1".to_owned()),
            },
        );
        assert_eq!(s.phase, UpdatePhase::Available);
        assert_eq!(s.available_version.as_deref(), Some("1.0.1"));

        s = apply_update_event(&s, &UpdateEvent::DownloadProgress { percent: 47.4 });
        assert_eq!(s.phase, UpdatePhase::Downloading);
        assert_eq!(s.percent, Some(47.4));

        s = apply_update_event(
            &s,
            &UpdateEvent::Downloaded {
                version: Some("1.0.1".to_owned()),
                can_install_now: false,
                at: 30.0,
            },
        );
        assert_eq!(s.phase, UpdatePhase::Ready);
        assert_eq!(s.percent, Some(100.0));
        assert!(!s.can_install_now);
    }

    #[test]
    fn moves_ready_to_installing_when_the_user_restarts_for_an_update() {
        let ready = apply_update_event(
            &base(),
            &UpdateEvent::Downloaded {
                version: Some("1.0.1".to_owned()),
                can_install_now: true,
                at: 30.0,
            },
        );
        let installing = apply_update_event(&ready, &UpdateEvent::Installing { at: 40.0 });

        assert_eq!(installing.phase, UpdatePhase::Installing);
        assert!(installing.manual);
        assert_eq!(installing.percent, Some(100.0));
        assert_eq!(installing.checked_at, Some(40.0));
        assert_eq!(installing.error, None);
    }

    #[test]
    fn uses_the_requested_automatic_error_backoff() {
        assert_eq!(next_retry_delay_ms(1.0), Some(15.0 * 60_000.0));
        assert_eq!(next_retry_delay_ms(2.0), Some(60.0 * 60_000.0));
        assert_eq!(next_retry_delay_ms(3.0), None);
    }

    #[test]
    fn only_allows_install_when_no_timer_is_open() {
        assert!(can_install_update(&TimerInstallState::Idle));
        assert!(!can_install_update(&TimerInstallState::Running {
            paused: false
        }));
        assert!(!can_install_update(&TimerInstallState::Running {
            paused: true
        }));
    }

    #[test]
    fn compares_beta_prerelease_numbers_numerically() {
        assert!(is_version_newer("0.0.2-beta.18", Some("0.0.2-beta.19")));
        assert!(!is_version_newer("0.0.2-beta.19", Some("0.0.2-beta.11")));
        assert!(!is_version_newer("0.0.2-beta.19", Some("0.0.2-beta.19")));
        assert!(is_version_newer("0.0.2-beta.19", Some("0.0.3-beta.1")));
    }

    #[test]
    fn ignores_stale_downloaded_updates_below_the_current_app_version() {
        let ready = apply_update_event(
            &initial_update_status(true, "0.0.2-beta.19", UpdateChannel::Beta, None),
            &UpdateEvent::Downloaded {
                version: Some("0.0.2-beta.11".to_owned()),
                can_install_now: true,
                at: 30.0,
            },
        );

        assert_eq!(ready.phase, UpdatePhase::NotAvailable);
        assert_eq!(ready.available_version, None);
        assert_eq!(ready.ready_at, None);
    }
}

mod floating_bar_position {
    use super::*;

    const SIZE: Size = Size {
        width: 248.0,
        height: 56.0,
    };
    // A single 1440x900 primary display whose work area starts at (0,0).
    const PRIMARY: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 1440.0,
        height: 900.0,
    };
    const SECOND: Rect = Rect {
        x: 1440.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
    };

    fn at(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    mod default_corner_ {
        use super::*;

        #[test]
        fn pins_to_the_bottom_right_of_the_work_area_with_the_edge_margin() {
            let p = default_corner(PRIMARY, SIZE);
            assert_eq!(p.x, 1440.0 - 248.0 - EDGE_MARGIN);
            assert_eq!(p.y, 900.0 - 56.0 - EDGE_MARGIN);
        }

        #[test]
        fn respects_a_non_zero_work_area_origin_eg_macos_menu_bar_dock_inset() {
            let inset = Rect {
                x: 0.0,
                y: 25.0,
                width: 1440.0,
                height: 850.0,
            };
            let p = default_corner(inset, SIZE);
            assert_eq!(p.y, 25.0 + 850.0 - 56.0 - EDGE_MARGIN);
        }
    }

    mod is_visible_enough_ {
        use super::*;

        #[test]
        fn true_when_the_bar_sits_fully_inside_the_work_area() {
            assert!(is_visible_enough(at(100.0, 100.0), SIZE, &[PRIMARY]));
        }

        #[test]
        fn false_when_the_bar_is_entirely_off_screen_monitor_unplugged() {
            assert!(!is_visible_enough(at(2000.0, 300.0), SIZE, &[PRIMARY]));
        }

        #[test]
        fn false_when_only_a_sliver_peeks_in_below_min_visible() {
            assert!(!is_visible_enough(
                at(1440.0 - 10.0, 400.0),
                SIZE,
                &[PRIMARY]
            ));
        }

        #[test]
        fn true_when_grabbable_amount_is_on_screen_at_the_right_edge() {
            assert!(is_visible_enough(
                at(1440.0 - 100.0, 400.0),
                SIZE,
                &[PRIMARY]
            ));
        }

        #[test]
        fn true_when_visible_on_a_secondary_display() {
            assert!(is_visible_enough(
                at(1600.0, 200.0),
                SIZE,
                &[PRIMARY, SECOND]
            ));
        }

        #[test]
        fn false_above_the_top_edge_by_more_than_the_bar_height() {
            assert!(!is_visible_enough(at(100.0, -100.0), SIZE, &[PRIMARY]));
        }
    }

    mod resolve_position_ {
        use super::*;

        #[test]
        fn returns_the_saved_position_verbatim_when_still_visible() {
            let saved = at(300.0, 250.0);
            assert_eq!(
                resolve_position(Some(saved), SIZE, PRIMARY, &[PRIMARY]),
                saved
            );
        }

        #[test]
        fn falls_back_to_the_default_corner_when_saved_is_off_screen() {
            let offscreen = at(5000.0, 5000.0);
            assert_eq!(
                resolve_position(Some(offscreen), SIZE, PRIMARY, &[PRIMARY]),
                default_corner(PRIMARY, SIZE)
            );
        }

        #[test]
        fn falls_back_to_the_default_corner_when_nothing_is_saved() {
            assert_eq!(
                resolve_position(None, SIZE, PRIMARY, &[PRIMARY]),
                default_corner(PRIMARY, SIZE)
            );
        }

        #[test]
        fn keeps_a_position_the_user_dragged_to_a_second_monitor() {
            let saved = at(2000.0, 500.0);
            assert_eq!(
                resolve_position(Some(saved), SIZE, PRIMARY, &[PRIMARY, SECOND]),
                saved
            );
        }
    }
}

mod overlay_placement {
    use super::*;
    use timo_core::placement::{BOTTOM_RIGHT_GUTTER, TOP_RIGHT_GUTTER, TRAY_POPOVER_GUTTER};

    const SIZE: Size = Size {
        width: 320.0,
        height: 168.0,
    };
    const PRIMARY: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 1440.0,
        height: 900.0,
    };
    const SECOND: Rect = Rect {
        x: 1440.0,
        y: 0.0,
        width: 1920.0,
        height: 1080.0,
    };

    mod center_ {
        use super::*;

        #[test]
        fn centers_on_the_usable_area_of_the_active_display() {
            let p = center(SECOND, SIZE);
            assert_eq!(p.x, (1440.0_f64 + (1920.0 - 320.0) / 2.0).round());
            assert_eq!(p.y, ((1080.0_f64 - 168.0) / 2.0).round());
        }
    }

    mod top_right_ {
        use super::*;

        #[test]
        fn pins_to_the_top_right_with_the_default_gutter() {
            let p = top_right(PRIMARY, SIZE, TOP_RIGHT_GUTTER);
            assert_eq!(p.x, 1440.0 - 320.0 - 16.0);
            assert_eq!(p.y, 16.0);
        }

        #[test]
        fn lands_on_the_secondary_monitor_when_given_its_work_area() {
            let p = top_right(SECOND, SIZE, TOP_RIGHT_GUTTER);
            assert_eq!(p.x, 1440.0 + 1920.0 - 320.0 - 16.0);
            assert_eq!(p.y, 16.0);
        }

        #[test]
        fn honors_a_custom_gutter() {
            let p = top_right(PRIMARY, SIZE, 40.0);
            assert_eq!(p.x, 1440.0 - 320.0 - 40.0);
            assert_eq!(p.y, 40.0);
        }
    }

    mod bottom_right_ {
        use super::*;

        #[test]
        fn pins_to_the_bottom_right_with_the_default_gutter() {
            let p = bottom_right(PRIMARY, SIZE, BOTTOM_RIGHT_GUTTER);
            assert_eq!(p.x, 1440.0 - 320.0 - 20.0);
            assert_eq!(p.y, 900.0 - 168.0 - 20.0);
        }

        #[test]
        fn accounts_for_a_macos_menu_bar_dock_inset_non_zero_y_origin() {
            let inset = Rect {
                x: 0.0,
                y: 25.0,
                width: 1440.0,
                height: 850.0,
            };
            let p = bottom_right(inset, SIZE, BOTTOM_RIGHT_GUTTER);
            assert_eq!(p.y, 25.0 + 850.0 - 168.0 - 20.0);
        }
    }

    mod tray_popover_point_ {
        use super::*;

        const POPOVER: Size = Size {
            width: 300.0,
            height: 340.0,
        };

        #[test]
        fn opens_below_a_macos_style_top_menu_bar_tray_icon() {
            let wa = Rect {
                x: 0.0,
                y: 25.0,
                width: 1440.0,
                height: 875.0,
            };
            let tray = Rect {
                x: 1180.0,
                y: 0.0,
                width: 24.0,
                height: 24.0,
            };
            let p = tray_popover_point(tray, wa, POPOVER, TRAY_POPOVER_GUTTER);

            assert_eq!(p.y, 31.0);
            assert_eq!(p.x, (1180.0_f64 + 12.0 - 150.0).round());
        }

        #[test]
        fn opens_above_a_windows_bottom_taskbar_tray_icon() {
            let wa = Rect {
                x: 0.0,
                y: 0.0,
                width: 1440.0,
                height: 860.0,
            };
            let tray = Rect {
                x: 1320.0,
                y: 860.0,
                width: 24.0,
                height: 40.0,
            };
            let p = tray_popover_point(tray, wa, POPOVER, TRAY_POPOVER_GUTTER);

            assert_eq!(p.y, 860.0 - 340.0 - 6.0);
            assert_eq!(p.x, 1440.0 - 300.0 - 6.0);
        }

        #[test]
        fn keeps_the_popover_inside_a_small_work_area() {
            let wa = Rect {
                x: 100.0,
                y: 50.0,
                width: 320.0,
                height: 360.0,
            };
            let tray = Rect {
                x: 390.0,
                y: 390.0,
                width: 24.0,
                height: 24.0,
            };
            let p = tray_popover_point(tray, wa, POPOVER, TRAY_POPOVER_GUTTER);

            assert_eq!(p.x, 114.0);
            assert_eq!(p.y, 56.0);
        }
    }
}
