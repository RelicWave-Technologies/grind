//! Pure state machine for the agent's "Ready to work?" popup.
//!
//! Port of `legacy/agent/src/main/services/shift/decide.ts`. The popup fires
//! inside the shift-start window (start time to start + `bufferMin`, both ends
//! inclusive), nudges every `nudgeIntervalMs`, and stays quiet once the user
//! says Yes (`ackedFor`), while a "Not yet" snooze runs, or while it is already
//! on screen. The reducer returns one action per tick.
//!
//! Instants are time values (whole milliseconds) but travel as `f64`, like the
//! TypeScript numbers in `ShiftMonitorState`; every instant derived from a zone
//! is exact in a double (they are below 2^53).

use serde::{Deserialize, Serialize};

use super::schedule::{DaySchedule, ShiftSchedule, hour_minute};
use crate::js::number::{add, i64_to_f64, max, strict_eq};
use crate::tz::civil::{add_calendar_days, make_day, weekday_from_days};
use crate::tz::{
    TzError, ZonedDateTimeParts, instant_for_zoned_date_time, is_valid_time_zone, time_clip,
    zoned_date_time_parts,
};

const FIVE_MIN_MS: f64 = 300_000.0;

/// Port of `ShiftMonitorState`. Field order is the TypeScript object's
/// (`{...state, x}` keeps the input's key order, and the app builds it this way).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShiftMonitorState {
    /// Epoch ms of today's shift start the user acknowledged with "Yes".
    pub acked_for: Option<f64>,
    /// Epoch ms before which the popup stays down (set by "Not yet").
    pub snoozed_until: Option<f64>,
    /// The popup is currently visible.
    pub prompting: bool,
}

/// Port of `INITIAL_STATE`.
pub const INITIAL_STATE: ShiftMonitorState = ShiftMonitorState {
    acked_for: None,
    snoozed_until: None,
    prompting: false,
};

/// Port of `ShiftAction`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ShiftAction {
    #[serde(rename_all = "camelCase")]
    Show {
        started_at: f64,
        buffer_until: f64,
    },
    Hide,
    #[serde(rename_all = "camelCase")]
    Schedule {
        next_at: f64,
    },
    Noop,
}

/// The argument object of `tickShiftMonitor`.
#[derive(Debug, Clone, Copy)]
pub struct TickInput<'a> {
    pub schedule: Option<&'a ShiftSchedule>,
    pub buffer_min: f64,
    pub state: ShiftMonitorState,
    /// A `Date`'s time value; beyond ±8.64e15 it is an invalid `Date`.
    pub now: f64,
    pub time_zone: &'a str,
    pub nudge_interval_ms: Option<f64>,
}

/// Port of `ResolvedShiftWindow`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedShiftWindow {
    pub start: String,
    pub end: String,
    pub started_at: f64,
    pub ended_at: f64,
}

/// A time value as a double (always exact: it is inside ±8.64e15 < 2^53).
fn exact(ms: i64) -> f64 {
    i64_to_f64(ms).unwrap_or(f64::NAN)
}

/// `date.getTime()`: the clipped time value, or `NaN` for an invalid `Date`.
fn get_time(date: f64) -> f64 {
    time_clip(date).map_or(f64::NAN, exact)
}

/// Port of `scheduleForDate`: the day entry for the weekday of a calendar date.
/// `new Date(Date.UTC(y, m - 1, d)).getUTCDay()` picks the weekday.
fn schedule_for_date(
    schedule: &ShiftSchedule,
    year: i64,
    month: i64,
    day: i64,
) -> Option<&DaySchedule> {
    schedule.day(weekday_from_days(make_day(year, month - 1, day)))
}

/// Port of `shiftInstantForDate`: the instant a `HH:MM` falls on a calendar
/// date in the zone, or `None` when that wall time does not exist (or the
/// string is not a time).
fn shift_instant_for_date(
    (year, month, day): (i64, i64, i64),
    hhmm: &str,
    time_zone: &str,
) -> Option<i64> {
    let (hour, minute) = hour_minute(hhmm)?;
    let parts = ZonedDateTimeParts {
        year,
        month,
        day,
        hour,
        minute,
        second: 0,
    };
    instant_for_zoned_date_time(&parts, time_zone).ok()
}

fn ymd(parts: &ZonedDateTimeParts) -> (i64, i64, i64) {
    (parts.year, parts.month, parts.day)
}

/// Port of `nextShiftStartMs`: the first shift start in the next eight calendar
/// days that is not before `now`.
fn next_shift_start_ms(
    schedule: &ShiftSchedule,
    now: f64,
    time_zone: &str,
) -> Result<Option<i64>, TzError> {
    let today = zoned_date_time_parts(now, time_zone)?;
    let now_ms = get_time(now);
    for offset in 0..=7 {
        let date = add_calendar_days(today.year, today.month, today.day, offset);
        let Some(day) = schedule_for_date(schedule, date.0, date.1, date.2) else {
            continue;
        };
        let Some(starts_at) = shift_instant_for_date(date, &day.start, time_zone) else {
            continue;
        };
        if exact(starts_at) < now_ms {
            continue;
        }
        return Ok(Some(starts_at));
    }
    Ok(None)
}

/// The window the popup is allowed in: today's start and start + buffer.
fn window_of(input: &TickInput<'_>, start: Option<i64>) -> Option<(f64, f64)> {
    let start = exact(start?);
    #[allow(
        clippy::float_arithmetic,
        reason = "Math.max(0, bufferMin) * 60_000, as written in the TypeScript"
    )]
    let buffer_ms = max(0.0, input.buffer_min) * 60_000.0;
    Some((start, add(start, buffer_ms)))
}

/// Port of `tickShiftMonitor`.
pub fn tick_shift_monitor(input: &TickInput<'_>) -> Result<ShiftAction, TzError> {
    let Some(schedule) = input.schedule else {
        return Ok(ShiftAction::Noop);
    };
    if !is_valid_time_zone(input.time_zone) {
        return Ok(ShiftAction::Noop);
    }
    let now_parts = zoned_date_time_parts(input.now, input.time_zone)?;
    let (year, month, day) = ymd(&now_parts);
    let todays_start = schedule_for_date(schedule, year, month, day)
        .and_then(|d| shift_instant_for_date(ymd(&now_parts), &d.start, input.time_zone));
    let window = window_of(input, todays_start);
    let now_ms = get_time(input.now);
    let in_window = window.filter(|(start, until)| now_ms >= *start && now_ms <= *until);

    let Some((start, until)) = in_window else {
        if input.state.prompting {
            return Ok(ShiftAction::Hide);
        }
        let next = next_shift_start_ms(schedule, input.now, input.time_zone)?;
        return Ok(next.map_or(ShiftAction::Noop, |at| ShiftAction::Schedule {
            next_at: exact(at),
        }));
    };
    let acked = input.state.acked_for.is_some_and(|a| strict_eq(a, start));
    let snoozed = input.state.snoozed_until.is_some_and(|s| now_ms < s);
    if acked || snoozed || input.state.prompting {
        return Ok(ShiftAction::Noop);
    }
    Ok(ShiftAction::Show {
        started_at: start,
        buffer_until: until,
    })
}

/// Port of `resolveShiftWindow`: today's shift in the workspace zone, `None`
/// on a day off, an unusable time, or an end that is not after the start
/// (an overnight shift has no window).
pub fn resolve_shift_window(
    schedule: &ShiftSchedule,
    now: f64,
    time_zone: &str,
) -> Result<Option<ResolvedShiftWindow>, TzError> {
    if !is_valid_time_zone(time_zone) {
        return Ok(None);
    }
    let date = zoned_date_time_parts(now, time_zone)?;
    let Some(day) = schedule_for_date(schedule, date.year, date.month, date.day) else {
        return Ok(None);
    };
    let started = shift_instant_for_date(ymd(&date), &day.start, time_zone);
    let ended = shift_instant_for_date(ymd(&date), &day.end, time_zone);
    Ok(match (started, ended) {
        (Some(s), Some(e)) if e > s => Some(ResolvedShiftWindow {
            start: day.start.clone(),
            end: day.end.clone(),
            started_at: exact(s),
            ended_at: exact(e),
        }),
        _ => None,
    })
}

/// Port of `ackToday`: the user's "Yes" acknowledges today's window.
pub fn ack_today(
    state: &ShiftMonitorState,
    schedule: &ShiftSchedule,
    now: f64,
    time_zone: &str,
) -> Result<ShiftMonitorState, TzError> {
    if !is_valid_time_zone(time_zone) {
        return Ok(*state);
    }
    let date = zoned_date_time_parts(now, time_zone)?;
    let started = schedule_for_date(schedule, date.year, date.month, date.day)
        .and_then(|day| shift_instant_for_date(ymd(&date), &day.start, time_zone));
    Ok(started.map_or(*state, |at| ShiftMonitorState {
        acked_for: Some(exact(at)),
        snoozed_until: None,
        prompting: false,
    }))
}

/// Port of `snooze`: "Not yet" holds the popup for `nudge_interval_ms`
/// (default 5 minutes).
#[must_use]
pub fn snooze(
    state: &ShiftMonitorState,
    now: f64,
    nudge_interval_ms: Option<f64>,
) -> ShiftMonitorState {
    ShiftMonitorState {
        snoozed_until: Some(add(get_time(now), nudge_interval_ms.unwrap_or(FIVE_MIN_MS))),
        prompting: false,
        ..*state
    }
}

/// Port of `expire`: the buffer ended without a "Yes". Clears the snooze so
/// tomorrow starts fresh; never acknowledges.
#[must_use]
pub const fn expire(state: &ShiftMonitorState) -> ShiftMonitorState {
    ShiftMonitorState {
        snoozed_until: None,
        prompting: false,
        ..*state
    }
}
