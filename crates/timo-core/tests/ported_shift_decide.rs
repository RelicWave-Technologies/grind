//! 1:1 port of `legacy/agent/src/main/services/shift/decide.test.ts`: same
//! names (`snake_case`), same cases, `describe` as a module.
#![cfg(test)]
#![allow(
    clippy::float_cmp,
    clippy::float_arithmetic,
    reason = "the ported tests compare the exact doubles the TypeScript tests compare, with the same arithmetic"
)]

use timo_core::js::date::{DateParse, parse};
use timo_core::shift::decide::{
    INITIAL_STATE, ResolvedShiftWindow, ShiftAction, ShiftMonitorState, TickInput, ack_today,
    expire, resolve_shift_window, snooze, tick_shift_monitor,
};
use timo_core::shift::schedule::{DaySchedule, ShiftSchedule};
use timo_core::tz::civil::{days_from_civil, weekday_from_days};
use timo_core::tz::{ZonedDateTimeParts, zoned_date_time_parts};

const TIME_ZONE: &str = "Asia/Kolkata";
const MIN: f64 = 60_000.0;

/// `new Date(`${yyyyMmDdHHmm}+05:30`)` as a time value.
fn at(local: &str) -> f64 {
    match parse(&format!("{local}+05:30")) {
        DateParse::Time(ms) => ms,
        other => panic!("not a date: {local} ({other:?})"),
    }
}

fn parts(value: f64) -> ZonedDateTimeParts {
    zoned_date_time_parts(value, TIME_ZONE).unwrap()
}

fn day(start: &str, end: &str) -> DaySchedule {
    DaySchedule {
        start: start.into(),
        end: end.into(),
    }
}

/// `NINE_TO_SIX` from `packages/types/src/shifts.ts`.
fn nine_to_six() -> ShiftSchedule {
    ShiftSchedule {
        mon: Some(day("09:00", "18:00")),
        tue: Some(day("09:00", "18:00")),
        wed: Some(day("09:00", "18:00")),
        thu: Some(day("09:00", "18:00")),
        fri: Some(day("09:00", "18:00")),
        sat: None,
        sun: None,
    }
}

/// `EMPTY_SCHEDULE`.
fn empty_schedule() -> ShiftSchedule {
    ShiftSchedule::default()
}

fn tick(
    schedule: Option<&ShiftSchedule>,
    buffer_min: f64,
    state: ShiftMonitorState,
    now: f64,
) -> ShiftAction {
    tick_shift_monitor(&TickInput {
        schedule,
        buffer_min,
        state,
        now,
        time_zone: TIME_ZONE,
        nudge_interval_ms: None,
    })
    .unwrap()
}

fn ack(state: &ShiftMonitorState, schedule: &ShiftSchedule, now: f64) -> ShiftMonitorState {
    ack_today(state, schedule, now, TIME_ZONE).unwrap()
}

fn prompting() -> ShiftMonitorState {
    ShiftMonitorState {
        prompting: true,
        ..INITIAL_STATE
    }
}

mod tick_shift_monitor_no_schedule {
    use super::*;

    #[test]
    fn null_schedule_noop() {
        let r = tick(None, 30.0, INITIAL_STATE, at("2026-06-01T09:00:00"));
        assert_eq!(r, ShiftAction::Noop);
    }
}

mod resolve_shift_window_tests {
    use super::*;

    #[test]
    fn returns_exact_workspace_local_shift_instants() {
        let window =
            resolve_shift_window(&nine_to_six(), at("2026-06-01T12:00:00"), TIME_ZONE).unwrap();
        assert_eq!(
            window,
            Some(ResolvedShiftWindow {
                start: "09:00".into(),
                end: "18:00".into(),
                started_at: at("2026-06-01T09:00:00"),
                ended_at: at("2026-06-01T18:00:00"),
            })
        );
    }

    #[test]
    fn returns_null_on_a_scheduled_day_off() {
        let window =
            resolve_shift_window(&nine_to_six(), at("2026-06-06T12:00:00"), TIME_ZONE).unwrap();
        assert_eq!(window, None);
    }
}

mod tick_shift_monitor_inside_the_buffer_window {
    use super::*;

    #[test]
    fn first_tick_inside_window_show_with_buffer_until_at_start_plus_buffer_min() {
        let now = at("2026-06-01T09:00:00"); // Monday at exactly start
        let r = tick(Some(&nine_to_six()), 30.0, INITIAL_STATE, now);
        let ShiftAction::Show {
            started_at,
            buffer_until,
        } = r
        else {
            panic!("narrow: {r:?}");
        };
        assert_eq!(started_at, now);
        assert_eq!(buffer_until, now + 30.0 * MIN);
    }

    #[test]
    fn still_inside_but_already_prompting_noop_no_stacking() {
        let r = tick(
            Some(&nine_to_six()),
            30.0,
            prompting(),
            at("2026-06-01T09:10:00"),
        );
        assert_eq!(r, ShiftAction::Noop);
    }

    #[test]
    fn inside_window_and_already_acked_today_noop() {
        let now = at("2026-06-01T09:10:00");
        // 09:00 same day
        let acked_for = Some(at("2026-06-01T09:00:00"));
        let state = ShiftMonitorState {
            acked_for,
            ..INITIAL_STATE
        };
        assert_eq!(
            tick(Some(&nine_to_six()), 30.0, state, now),
            ShiftAction::Noop
        );
    }

    #[test]
    fn inside_window_and_snoozed_until_after_now_noop() {
        let now = at("2026-06-01T09:10:00");
        let state = ShiftMonitorState {
            snoozed_until: Some(now + 60_000.0),
            ..INITIAL_STATE
        };
        assert_eq!(
            tick(Some(&nine_to_six()), 30.0, state, now),
            ShiftAction::Noop
        );
    }

    #[test]
    fn inside_window_and_snooze_expired_show_again() {
        let now = at("2026-06-01T09:10:00");
        let state = ShiftMonitorState {
            snoozed_until: Some(now - 1_000.0),
            ..INITIAL_STATE
        };
        let r = tick(Some(&nine_to_six()), 30.0, state, now);
        assert!(matches!(r, ShiftAction::Show { .. }), "{r:?}");
    }
}

mod tick_shift_monitor_outside_the_window {
    use super::*;

    fn next_at(r: ShiftAction) -> f64 {
        let ShiftAction::Schedule { next_at } = r else {
            panic!("narrow: {r:?}");
        };
        next_at
    }

    #[test]
    fn before_todays_start_schedule_for_todays_start() {
        let now = at("2026-06-01T08:00:00");
        let r = tick(Some(&nine_to_six()), 30.0, INITIAL_STATE, now);
        let next = parts(next_at(r));
        assert_eq!(next.hour, 9);
        assert_eq!(next.day, 1);
    }

    #[test]
    fn after_buffer_expires_today_schedule_for_tomorrows_start() {
        let now = at("2026-06-01T10:00:00");
        let r = tick(Some(&nine_to_six()), 30.0, INITIAL_STATE, now);
        assert_eq!(parts(next_at(r)).day, 2);
    }

    #[test]
    fn weekend_schedule_for_monday() {
        let now = at("2026-06-06T10:00:00"); // Saturday
        let r = tick(Some(&nine_to_six()), 30.0, INITIAL_STATE, now);
        let p = parts(next_at(r));
        assert_eq!(
            weekday_from_days(days_from_civil(p.year, p.month, p.day)),
            1
        ); // Mon
    }

    #[test]
    fn outside_window_and_popup_currently_visible_hide() {
        let r = tick(
            Some(&nine_to_six()),
            30.0,
            prompting(),
            at("2026-06-01T10:00:00"),
        );
        assert_eq!(r, ShiftAction::Hide);
    }

    #[test]
    fn outside_window_and_empty_schedule_noop() {
        let r = tick(
            Some(&empty_schedule()),
            30.0,
            INITIAL_STATE,
            at("2026-06-01T09:00:00"),
        );
        assert_eq!(r, ShiftAction::Noop);
    }
}

mod state_mutators {
    use super::*;

    #[test]
    fn ack_today_stamps_todays_start_clears_snooze_and_prompting() {
        let now = at("2026-06-01T09:30:00");
        let base = ShiftMonitorState {
            snoozed_until: Some(12345.0),
            ..prompting()
        };
        let next = ack(&base, &nine_to_six(), now);
        assert_eq!(next.acked_for, Some(at("2026-06-01T09:00:00")));
        assert_eq!(next.snoozed_until, None);
        assert!(!next.prompting);
    }

    #[test]
    fn ack_today_is_a_no_op_on_a_day_off_saturday() {
        let sat = at("2026-06-06T09:30:00");
        let base = prompting();
        assert_eq!(ack(&base, &nine_to_six(), sat), base);
    }

    #[test]
    fn snooze_sets_snoozed_until_to_now_plus_interval_clears_prompting() {
        let now = at("2026-06-01T09:10:00");
        let next = snooze(&prompting(), now, Some(7.0 * MIN));
        assert_eq!(next.snoozed_until, Some(now + 7.0 * MIN));
        assert!(!next.prompting);
    }

    #[test]
    fn snooze_default_interval_is_5_min() {
        let now = at("2026-06-01T09:10:00");
        let next = snooze(&prompting(), now, None);
        assert_eq!(next.snoozed_until, Some(now + 5.0 * MIN));
    }

    #[test]
    fn expire_clears_snooze_and_prompting_but_never_acks() {
        let next = expire(&ShiftMonitorState {
            snoozed_until: Some(999.0),
            acked_for: None,
            ..prompting()
        });
        assert_eq!(next.snoozed_until, None);
        assert!(!next.prompting);
        assert_eq!(next.acked_for, None);
    }
}

mod full_lifecycle {
    use super::*;

    #[test]
    fn yes_at_first_show_stays_silent_for_the_rest_of_the_buffer_and_tomorrow_re_arms() {
        let schedule = nine_to_six();
        let st = INITIAL_STATE;
        let today9 = at("2026-06-01T09:00:00");
        let r = tick(Some(&schedule), 30.0, st, today9);
        assert!(matches!(r, ShiftAction::Show { .. }), "{r:?}");
        let st = ack(
            &ShiftMonitorState {
                prompting: true,
                ..st
            },
            &schedule,
            today9,
        );
        // 15 minutes later still inside buffer
        let r = tick(Some(&schedule), 30.0, st, at("2026-06-01T09:15:00"));
        assert_eq!(r, ShiftAction::Noop);
        // Tomorrow morning the ack key is for 06-01, today is 06-02 -> re-fire
        let r = tick(Some(&schedule), 30.0, st, at("2026-06-02T09:00:00"));
        assert!(matches!(r, ShiftAction::Show { .. }), "{r:?}");
    }

    #[test]
    fn not_yet_then_re_fires_after_the_5_min_snooze() {
        let schedule = nine_to_six();
        let st = snooze(&prompting(), at("2026-06-01T09:00:00"), None);
        // 4 minutes later -> noop
        let r = tick(Some(&schedule), 30.0, st, at("2026-06-01T09:04:00"));
        assert_eq!(r, ShiftAction::Noop);
        // 6 minutes later -> show again
        let r = tick(Some(&schedule), 30.0, st, at("2026-06-01T09:06:00"));
        assert!(matches!(r, ShiftAction::Show { .. }), "{r:?}");
    }

    #[test]
    fn snooze_past_buffer_expiry_no_show_then_scheduled_for_tomorrow() {
        let schedule = nine_to_six();
        let st = snooze(&INITIAL_STATE, at("2026-06-01T09:25:00"), None); // expires 09:30
        // 09:31 - past buffer
        let r = tick(Some(&schedule), 30.0, st, at("2026-06-01T09:31:00"));
        let ShiftAction::Schedule { next_at } = r else {
            panic!("narrow: {r:?}");
        };
        assert_eq!(parts(next_at).day, 2);
    }
}
