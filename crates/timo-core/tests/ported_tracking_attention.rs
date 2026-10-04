//! 1:1 port of `trackingAttention.test.ts`
//! (legacy/agent/src/main/services/trackingAttention.test.ts).
#![cfg(test)]
#![allow(
    clippy::float_cmp,
    reason = "the ported tests compare the exact doubles the TypeScript tests compare"
)]

mod attention_support;

use attention_support::{Call, Predicate, Rig};
use timo_core::tracking_attention::{
    AttentionLog, AttentionPrompt, AwayInfo, AwayReason, IdleWarningInfo, LogLevel,
    PermissionIntent, PermissionPresentation,
};

/// The test's `setup()`: a coordinator on a fake host with a logger.
fn setup() -> Rig {
    Rig::new(true)
}

fn kind(rig: &Rig) -> &'static str {
    rig.coordinator.get().kind()
}

fn count(rig: &Rig, pred: impl Fn(&Call) -> bool) -> usize {
    rig.env().count(pred)
}

fn n_place(rig: &Rig) -> usize {
    count(rig, |c| matches!(c, Call::Place { .. }))
}
fn n_keep(rig: &Rig) -> usize {
    count(rig, |c| matches!(c, Call::Keep))
}
fn n_activate(rig: &Rig) -> usize {
    count(rig, |c| matches!(c, Call::Activate))
}
fn n_hide(rig: &Rig) -> usize {
    count(rig, |c| matches!(c, Call::Hide))
}
fn n_release(rig: &Rig) -> usize {
    count(rig, |c| matches!(c, Call::Release))
}
fn n_lower(rig: &Rig) -> usize {
    count(rig, |c| matches!(c, Call::Lower))
}
fn n_publish(rig: &Rig) -> usize {
    count(rig, |c| matches!(c, Call::Publish { .. }))
}

fn away(guid: Option<&str>, stopped_at: f64, reason: AwayReason) -> AwayInfo {
    AwayInfo {
        lark_task_guid: guid.map(str::to_owned),
        stopped_at,
        reason,
    }
}

fn warning(idle_started_at: f64, deadline_at: f64) -> IdleWarningInfo {
    IdleWarningInfo {
        idle_started_at,
        deadline_at,
    }
}

fn permission_id(rig: &Rig) -> String {
    match rig.coordinator.get() {
        AttentionPrompt::Permission { prompt_id, .. } => prompt_id.clone(),
        other => panic!("expected permission prompt, got {other:?}"),
    }
}

mod tracking_attention_coordinator_priority {
    use super::*;

    #[test]
    fn reuses_one_prompt_while_an_idle_warning_becomes_a_paused_idle_prompt() {
        let mut rig = setup();

        assert!(rig.coordinator.request_idle_warning(warning(100.0, 200.0)));
        let AttentionPrompt::IdleWarning { prompt_id, .. } = rig.coordinator.get().clone() else {
            panic!("expected warning prompt");
        };

        assert!(rig.coordinator.request_idle(100.0));
        assert!(matches!(
            rig.coordinator.get(),
            AttentionPrompt::Idle { prompt_id: id, .. } if *id == prompt_id
        ));
        assert_eq!(n_publish(&rig), 2);
    }

    #[test]
    fn clears_only_an_active_idle_warning() {
        let mut rig = setup();
        rig.coordinator.request_idle_warning(warning(100.0, 200.0));

        assert!(rig.coordinator.clear_idle_warning());
        assert_eq!(*rig.coordinator.get(), AttentionPrompt::None);
        assert!(!rig.coordinator.clear_idle_warning());
    }

    #[test]
    fn allows_only_one_prompt_and_gives_permission_the_highest_priority() {
        let mut rig = setup();

        assert!(rig.coordinator.request_idle(100.0));
        rig.coordinator
            .request_permission(PermissionIntent::StartTask);

        assert!(matches!(
            rig.coordinator.get(),
            AttentionPrompt::Permission {
                intent: PermissionIntent::StartTask,
                ..
            }
        ));
        assert!(!rig.coordinator.request_idle(200.0));
        assert!(
            !rig.coordinator
                .request_away(away(Some("task-1"), 300.0, AwayReason::Lock))
        );
    }

    #[test]
    fn discards_idle_before_presenting_one_welcome_back_prompt() {
        let mut rig = setup();
        rig.coordinator.request_idle(100.0);

        rig.coordinator.begin_machine_away();
        assert_eq!(*rig.coordinator.get(), AttentionPrompt::None);
        assert_eq!(n_hide(&rig), 1);

        assert!(
            rig.coordinator
                .request_away(away(None, 200.0, AwayReason::Suspend))
        );
        assert!(matches!(
            rig.coordinator.get(),
            AttentionPrompt::Away {
                reason: AwayReason::Suspend,
                ..
            }
        ));
    }

    #[test]
    fn keeps_one_permission_identity_while_changing_intent_or_presentation() {
        let mut rig = setup();
        let first = rig.coordinator.request_permission(PermissionIntent::Setup);
        let AttentionPrompt::Permission {
            prompt_id: first_id,
            ..
        } = first
        else {
            panic!("expected permission prompt");
        };

        assert!(rig.yield_to_settings(&first_id, None));
        assert!(matches!(
            rig.coordinator.get(),
            AttentionPrompt::Permission {
                presentation: PermissionPresentation::YieldedToSettings,
                ..
            }
        ));
        assert_eq!(n_lower(&rig), 1);

        let second = rig
            .coordinator
            .request_permission(PermissionIntent::ResumeEntry);
        assert_eq!(
            second,
            AttentionPrompt::Permission {
                prompt_id: first_id,
                intent: PermissionIntent::ResumeEntry,
                presentation: PermissionPresentation::Front,
            }
        );
    }

    #[test]
    fn rejects_stale_clear_and_stale_permission_yield_actions() {
        let mut rig = setup();
        let prompt = rig
            .coordinator
            .request_permission(PermissionIntent::StartTask);

        assert!(!rig.coordinator.clear(Some("older-prompt")));
        assert!(!rig.yield_to_settings("older-prompt", None));
        assert_eq!(*rig.coordinator.get(), prompt);
    }
}

mod tracking_attention_coordinator_handing_off_to_the_keeper {
    use super::*;

    #[test]
    fn places_once_and_hands_the_surface_to_the_keeper() {
        let mut rig = setup();
        rig.coordinator.request_idle(100.0);

        // Staying on top is the shared overlay keeper's job.
        assert_eq!(n_place(&rig), 1);
        assert_eq!(n_keep(&rig), 1);
    }

    #[test]
    fn releases_the_keeper_when_the_prompt_is_cleared() {
        let mut rig = setup();
        rig.coordinator.request_idle(100.0);
        let id = rig.coordinator.get().prompt_id().unwrap().to_owned();

        rig.coordinator.clear(Some(&id));

        assert!(n_release(&rig) > 0);
        assert!(n_hide(&rig) > 0);
    }

    #[test]
    fn releases_the_keeper_when_the_machine_goes_away() {
        let mut rig = setup();
        rig.coordinator.request_idle(100.0);

        rig.coordinator.begin_machine_away();

        assert!(n_release(&rig) > 0);
    }

    #[test]
    fn re_places_when_a_different_prompt_kind_takes_over() {
        let mut rig = setup();
        rig.coordinator.request_idle(100.0);
        rig.coordinator.request_permission(PermissionIntent::Setup);

        // Each presentation resolves its own bounds once.
        assert_eq!(n_place(&rig), 2);
        assert_eq!(n_keep(&rig), 2);
    }

    #[test]
    fn presents_once_the_renderer_finishes_loading() {
        let mut rig = setup();
        rig.coordinator.request_idle(100.0);
        let before = n_keep(&rig);

        rig.fire_ready();

        assert!(n_keep(&rig) > before);
    }
}

mod tracking_attention_coordinator_suspension {
    use super::*;

    #[test]
    fn does_not_fight_system_settings_while_suspended() {
        let mut rig = setup();
        let id = {
            rig.coordinator.request_permission(PermissionIntent::Setup);
            permission_id(&rig)
        };

        rig.yield_to_settings(&id, None);
        let keeps_after_yield = n_keep(&rig);

        rig.tick();
        rig.tick();

        // Lowering releases the keeper, so nothing climbs back over Settings.
        assert!(n_lower(&rig) > 0);
        assert_eq!(n_keep(&rig), keeps_after_yield);
    }

    #[test]
    fn comes_back_by_itself_once_the_resume_predicate_is_satisfied() {
        let mut rig = setup();
        rig.coordinator.request_permission(PermissionIntent::Setup);
        let id = permission_id(&rig);

        rig.granted = false;
        rig.yield_to_settings(&id, Some(Predicate::Flag));

        rig.tick();
        rig.tick();
        rig.flush();
        assert!(matches!(
            rig.coordinator.get(),
            AttentionPrompt::Permission {
                presentation: PermissionPresentation::YieldedToSettings,
                ..
            }
        ));

        rig.granted = true;
        rig.tick();
        rig.tick();
        rig.flush();

        assert!(matches!(
            rig.coordinator.get(),
            AttentionPrompt::Permission {
                presentation: PermissionPresentation::Front,
                ..
            }
        ));
        assert!(n_keep(&rig) > 0);
    }

    #[test]
    fn keeps_retrying_if_the_resume_predicate_throws() {
        let mut rig = setup();
        rig.coordinator.request_permission(PermissionIntent::Setup);
        let id = permission_id(&rig);

        rig.yield_to_settings(&id, Some(Predicate::Throws));

        rig.tick();
        rig.tick();
        rig.flush();
        rig.tick();
        rig.tick();
        rig.flush();

        assert!(rig.predicate_calls > 1);
        assert!(matches!(
            rig.coordinator.get(),
            AttentionPrompt::Permission {
                presentation: PermissionPresentation::YieldedToSettings,
                ..
            }
        ));
    }
}

mod tracking_attention_coordinator_releasing_a_prompt_nobody_can_reach {
    use super::*;

    #[test]
    fn clears_the_prompt_hides_the_overlay_and_says_so() {
        let mut rig = setup();
        rig.coordinator
            .request_away(away(None, 1_000.0, AwayReason::Suspend));
        assert_eq!(kind(&rig), "AWAY");

        assert!(
            rig.coordinator
                .release_unreachable("main_window_requested_twice")
        );

        assert_eq!(*rig.coordinator.get(), AttentionPrompt::None);
        assert!(n_hide(&rig) > 0);
        let last_publish = rig
            .env()
            .calls
            .iter()
            .rev()
            .find_map(|c| match c {
                Call::Publish { prompt } => Some(prompt.clone()),
                _ => None,
            })
            .unwrap();
        assert_eq!(last_publish, AttentionPrompt::None);
        let logs = rig.env().logs();
        let warn = logs
            .iter()
            .find(|e| e.level == LogLevel::Warn)
            .expect("a warn log");
        assert_eq!(warn.message, "attention prompt released as unreachable");
        assert!(matches!(
            &warn.meta,
            AttentionLog::Released { kind: "AWAY", reason, .. }
                if reason == "main_window_requested_twice"
        ));
    }

    #[test]
    fn is_a_no_op_when_nothing_is_active() {
        let mut rig = setup();
        assert!(!rig.coordinator.release_unreachable("whatever"));
        assert!(rig.env().logs().iter().all(|e| e.level != LogLevel::Warn));
    }

    #[test]
    fn releases_a_permission_prompt_too_so_settings_cannot_wedge_the_app() {
        let mut rig = setup();
        rig.coordinator.request_permission(PermissionIntent::Setup);
        assert!(
            rig.coordinator
                .release_unreachable("main_window_requested_twice")
        );
        assert_eq!(*rig.coordinator.get(), AttentionPrompt::None);
    }

    #[test]
    fn lets_a_fresh_prompt_be_shown_afterwards() {
        let mut rig = setup();
        rig.coordinator
            .request_away(away(None, 1_000.0, AwayReason::Suspend));
        rig.coordinator
            .release_unreachable("main_window_requested_twice");

        // The wedge is gone: the next real prompt is accepted normally.
        assert!(rig.coordinator.request_idle(500.0));
        assert_eq!(kind(&rig), "IDLE");
    }

    #[test]
    fn stops_the_resume_poll_so_a_released_permission_prompt_cannot_come_back_by_itself() {
        let mut rig = setup();
        rig.coordinator.request_permission(PermissionIntent::Setup);
        let id = permission_id(&rig);
        rig.yield_to_settings(&id, Some(Predicate::Always));

        rig.coordinator
            .release_unreachable("main_window_requested_twice");
        rig.tick();

        assert_eq!(*rig.coordinator.get(), AttentionPrompt::None);
    }
}

mod tracking_attention_coordinator_a_prompt_leaves_a_trace {
    use super::*;

    #[test]
    fn logs_the_prompt_going_up_with_what_we_believe_about_the_float() {
        let mut rig = setup();
        rig.coordinator.request_idle(100.0);
        let logs = rig.env().logs();
        assert!(logs.iter().any(|e| e.level == LogLevel::Info
            && e.message == "attention prompt shown"
            && matches!(
                &e.meta,
                AttentionLog::Shown {
                    kind: "IDLE",
                    floating: true,
                    ..
                }
            )));
    }

    #[test]
    fn logs_a_restore_and_still_reports_that_a_prompt_existed() {
        let mut rig = setup();
        rig.coordinator.request_idle(100.0);
        rig.coordinator.env_mut().clear_calls();

        assert!(rig.coordinator.restore_active());
        let logs = rig.env().logs();
        assert!(logs.iter().any(|e| e.message == "attention prompt restored"
            && matches!(&e.meta, AttentionLog::Restored { kind: "IDLE", .. })));
    }

    #[test]
    fn records_the_float_belief_as_false_when_the_overlay_is_not_on_top() {
        let mut rig = setup();
        rig.coordinator.request_idle(100.0);
        // `host.lower()` straight on the fake host.
        rig.coordinator.env_mut().on_top = false;
        rig.coordinator.env_mut().clear_calls();

        rig.coordinator.restore_active();
        // keep() runs during present, so the belief is true again by the time we
        // look: the value is evidence of what the app thinks, not proof of sight.
        let logs = rig.env().logs();
        assert!(logs.iter().any(|e| e.message == "attention prompt restored"
            && matches!(&e.meta, AttentionLog::Restored { kind: "IDLE", .. })));
    }

    #[test]
    fn logs_the_prompt_being_cleared_normally() {
        let mut rig = setup();
        rig.coordinator.request_idle(100.0);
        rig.coordinator.clear(None);
        let logs = rig.env().logs();
        assert!(logs.iter().any(|e| e.message == "attention prompt cleared"
            && matches!(&e.meta, AttentionLog::Cleared { kind: "IDLE", .. })));
    }

    #[test]
    fn restore_active_on_nothing_reports_false_and_logs_nothing() {
        let mut rig = setup();
        assert!(!rig.coordinator.restore_active());
        assert!(rig.env().logs().is_empty());
    }
}

mod tracking_attention_coordinator_presentation_activates_holding_does_not {
    use super::*;

    #[test]
    fn releases_the_surface_whenever_a_prompt_ends() {
        let mut rig = setup();

        rig.coordinator.request_idle(100.0);
        rig.coordinator.clear(None);
        assert_eq!(n_hide(&rig), 1);

        rig.coordinator.request_idle(200.0);
        rig.coordinator.clear(None);
        assert_eq!(n_hide(&rig), 2);
    }

    #[test]
    fn places_the_surface_again_for_every_prompt_rather_than_assuming_it_survived() {
        let mut rig = setup();

        rig.coordinator.request_idle(100.0);
        let placed_for_first = n_place(&rig);
        rig.coordinator.clear(None);

        rig.coordinator
            .request_away(away(None, 1_000.0, AwayReason::Suspend));

        // A second placement proves the coordinator does not depend on the
        // previous window still existing.
        assert!(n_place(&rig) > placed_for_first);
    }

    #[test]
    fn hides_on_release_too_so_an_unreachable_prompt_does_not_leave_a_window_behind() {
        let mut rig = setup();
        rig.coordinator.request_idle(100.0);

        rig.coordinator
            .release_unreachable("main_window_requested_twice");

        assert_eq!(n_hide(&rig), 1);
    }
}

mod tracking_attention_coordinator_activation_is_rationed_to_presentation {
    use super::*;

    #[test]
    fn activates_when_a_prompt_is_shown() {
        let mut rig = setup();
        rig.coordinator.request_idle(100.0);
        assert_eq!(n_activate(&rig), 1);
    }

    #[test]
    fn activates_again_when_the_prompt_is_restored_because_that_is_a_new_ask() {
        let mut rig = setup();
        rig.coordinator.request_idle(100.0);
        rig.coordinator.env_mut().clear_calls();

        rig.coordinator.restore_active();

        assert_eq!(n_activate(&rig), 1);
    }

    #[test]
    fn does_not_activate_for_a_prompt_that_is_standing_down_for_system_settings() {
        let mut rig = setup();
        rig.coordinator.request_permission(PermissionIntent::Setup);
        let id = permission_id(&rig);
        rig.coordinator.env_mut().clear_calls();

        rig.yield_to_settings(&id, Some(Predicate::Never));

        // Yielding is the opposite of asking for attention.
        assert_eq!(n_activate(&rig), 0);
    }

    #[test]
    fn never_activates_more_than_once_per_presentation() {
        let mut rig = setup();
        rig.coordinator.request_idle_warning(warning(100.0, 200.0));
        assert_eq!(n_activate(&rig), 1);

        // The warning becoming a paused idle prompt is a second presentation.
        rig.coordinator.request_idle(100.0);
        assert_eq!(n_activate(&rig), 2);
    }
}
