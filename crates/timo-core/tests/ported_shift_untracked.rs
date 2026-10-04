//! 1:1 port of `legacy/agent/src/main/services/shift/untracked.test.ts`: same
//! names (`snake_case`), same cases, `describe` as a module.
#![cfg(test)]
#![allow(
    clippy::float_cmp,
    clippy::float_arithmetic,
    reason = "the ported tests compare the exact doubles the TypeScript tests compare, with the same arithmetic"
)]

use timo_core::shift::untracked::{
    ACTIVE_STREAK_MS, SNOOZE_MS, UNTRACKED_INITIAL_STATE, UntrackedAction, UntrackedNudgeState,
    UntrackedTickInput, accept_untracked_nudge, snooze_untracked_nudge, tick_untracked_nudge,
};
use timo_core::tz::civil::days_from_civil;

/// `Date.UTC(2026, 7, 10, 5, 0, 0)`: 10:30 IST, mid-shift.
fn t0() -> f64 {
    f64::from(i32::try_from(days_from_civil(2026, 8, 10)).unwrap()) * 86_400_000.0
        + 5.0 * 3_600_000.0
}

const MINUTE: f64 = 60_000.0;

/// A user sitting at their machine, in shift, with no timer running.
fn working() -> UntrackedTickInput {
    UntrackedTickInput {
        state: UNTRACKED_INITIAL_STATE,
        now: t0(),
        in_shift: true,
        tracking: false,
        idle_seconds: 2.0,
        attention_busy: false,
    }
}

struct Run {
    state: UntrackedNudgeState,
    action: UntrackedAction,
    shown: bool,
}

/// Tick once a minute from T0 through T0+minutes, threading state through so
/// the streak accumulates exactly as it would in the running service.
fn run_minutes(minutes: i32, over: impl Fn(UntrackedTickInput) -> UntrackedTickInput) -> Run {
    run_from(UNTRACKED_INITIAL_STATE, minutes, over)
}

fn run_from(
    start: UntrackedNudgeState,
    minutes: i32,
    over: impl Fn(UntrackedTickInput) -> UntrackedTickInput,
) -> Run {
    let mut state = start;
    let mut actions = Vec::new();
    for minute in 0..=minutes {
        let input = over(working());
        let result = tick_untracked_nudge(&UntrackedTickInput {
            state,
            now: t0() + f64::from(minute) * MINUTE,
            ..input
        });
        state = result.state;
        actions.push(result.action);
    }
    Run {
        state,
        action: *actions.last().unwrap(),
        // Whether the toast came up at ANY point. Asserting only on the final
        // action hides a nudge that fired mid-run and then went quiet because
        // `prompting` was already set.
        shown: actions.contains(&UntrackedAction::Show),
    }
}

fn same(i: UntrackedTickInput) -> UntrackedTickInput {
    i
}

fn tick_at(
    state: UntrackedNudgeState,
    now: f64,
    over: impl Fn(&mut UntrackedTickInput),
) -> timo_core::shift::untracked::UntrackedTickResult {
    let mut input = UntrackedTickInput {
        state,
        now,
        ..working()
    };
    over(&mut input);
    tick_untracked_nudge(&input)
}

mod tick_untracked_nudge_tests {
    use super::*;

    #[test]
    fn stays_quiet_before_the_streak_matures() {
        let r = run_minutes(9, same);
        assert_eq!(r.action, UntrackedAction::Noop);
    }

    #[test]
    fn asks_once_the_user_has_been_working_untracked_for_the_full_streak() {
        let r = run_minutes(10, same);
        assert_eq!(r.action, UntrackedAction::Show);
        assert!(r.state.prompting);
    }

    #[test]
    fn does_not_ask_again_on_every_following_tick() {
        let matured = run_minutes(10, same);
        let next = tick_at(matured.state, t0() + 11.0 * MINUTE, |_| {});
        assert_eq!(next.action, UntrackedAction::Noop);
    }

    #[test]
    fn never_asks_while_a_timer_is_already_running() {
        assert!(
            !run_minutes(30, |i| UntrackedTickInput {
                tracking: true,
                ..i
            })
            .shown
        );
    }

    #[test]
    fn never_asks_outside_the_shift() {
        assert!(
            !run_minutes(30, |i| UntrackedTickInput {
                in_shift: false,
                ..i
            })
            .shown
        );
    }
}

mod not_being_annoying {
    use super::*;

    #[test]
    fn does_not_let_a_lunch_break_mature_into_a_nudge() {
        // Away for 40 minutes: wall-clock time passes, but the streak is driven by
        // the idle timer, so nothing accumulates and nobody is nagged on return.
        let away = run_minutes(40, |i| UntrackedTickInput {
            idle_seconds: 15.0 * 60.0,
            ..i
        });
        assert!(!away.shown);
        assert_eq!(away.state.active_since, None);

        // Back at the desk: the clock starts from scratch.
        let back_at_desk = tick_at(away.state, t0() + 41.0 * MINUTE, |_| {});
        assert_eq!(back_at_desk.action, UntrackedAction::Noop);
        assert_eq!(back_at_desk.state.active_since, Some(t0() + 41.0 * MINUTE));
    }

    #[test]
    fn takes_a_stale_toast_down_when_the_user_walks_away() {
        let matured = run_minutes(10, same);
        let walked_off = tick_at(matured.state, t0() + 20.0 * MINUTE, |i| {
            i.idle_seconds = 5.0 * 60.0;
        });
        assert_eq!(walked_off.action, UntrackedAction::Hide);
        assert!(!walked_off.state.prompting);
    }

    #[test]
    fn takes_the_toast_down_as_soon_as_tracking_starts() {
        let matured = run_minutes(10, same);
        let started = tick_at(matured.state, t0() + 11.0 * MINUTE, |i| i.tracking = true);
        assert_eq!(started.action, UntrackedAction::Hide);
    }

    #[test]
    fn yields_to_an_idle_away_or_permission_prompt_instead_of_stacking() {
        let busy = run_minutes(10, |i| UntrackedTickInput {
            attention_busy: true,
            ..i
        });
        assert!(!busy.shown);
        assert!(!busy.state.prompting);
    }

    #[test]
    fn does_not_bank_time_spent_behind_another_prompt() {
        // The prompt in the way is usually the idle one, which means the user was
        // away. Banking that time would nudge them about work they never did, so
        // the streak restarts once the screen is theirs again.
        let busy = run_minutes(10, |i| UntrackedTickInput {
            attention_busy: true,
            ..i
        });
        let cleared = tick_at(busy.state, t0() + 11.0 * MINUTE, |_| {});

        assert_eq!(cleared.action, UntrackedAction::Noop);
        assert_eq!(cleared.state.active_since, Some(t0() + 11.0 * MINUTE));
    }

    #[test]
    fn asks_again_after_a_fresh_streak_once_the_screen_is_free() {
        let busy = run_minutes(10, |i| UntrackedTickInput {
            attention_busy: true,
            ..i
        });
        let r = run_from(busy.state, 10, same);

        assert_eq!(r.action, UntrackedAction::Show);
    }
}

mod not_now {
    use super::*;

    #[test]
    fn stays_quiet_for_the_whole_snooze() {
        let matured = run_minutes(10, same);
        let snoozed = snooze_untracked_nudge(&matured.state, t0() + 10.0 * MINUTE, None);

        let midway = tick_at(snoozed, t0() + 10.0 * MINUTE + SNOOZE_MS - MINUTE, |_| {});
        assert_eq!(midway.action, UntrackedAction::Noop);
    }

    #[test]
    fn comes_back_the_moment_the_snooze_lapses_on_a_user_who_still_has_not_started() {
        let matured = run_minutes(10, same);
        let snoozed = snooze_untracked_nudge(&matured.state, t0() + 10.0 * MINUTE, None);

        let after = tick_at(snoozed, t0() + 10.0 * MINUTE + SNOOZE_MS + 1_000.0, |_| {});
        assert_eq!(after.action, UntrackedAction::Show);
    }

    #[test]
    fn requires_a_fresh_streak_if_the_user_left_during_the_snooze() {
        let matured = run_minutes(10, same);
        let mut state = snooze_untracked_nudge(&matured.state, t0() + 10.0 * MINUTE, None);
        state = tick_at(state, t0() + 20.0 * MINUTE, |i| {
            i.idle_seconds = 10.0 * 60.0;
        })
        .state;

        let just_back = tick_at(state, t0() + 10.0 * MINUTE + SNOOZE_MS + 1_000.0, |_| {});
        assert_eq!(just_back.action, UntrackedAction::Noop);
    }
}

mod user_decisions {
    use super::*;

    #[test]
    fn clears_everything_when_the_user_says_yes() {
        let matured = run_minutes(10, same);
        let accepted = accept_untracked_nudge(&matured.state);

        assert_eq!(
            accepted,
            UntrackedNudgeState {
                active_since: None,
                snoozed_until: None,
                prompting: false
            }
        );
    }

    #[test]
    fn uses_the_configured_snooze_length() {
        let snoozed = snooze_untracked_nudge(&UNTRACKED_INITIAL_STATE, t0(), None);
        assert_eq!(snoozed.snoozed_until, Some(t0() + SNOOZE_MS));
        assert!(!snoozed.prompting);
    }

    #[test]
    fn agrees_with_the_documented_ten_minute_streak() {
        assert_eq!(ACTIVE_STREAK_MS, 10.0 * MINUTE);
        assert_eq!(SNOOZE_MS, 30.0 * MINUTE);
    }
}
