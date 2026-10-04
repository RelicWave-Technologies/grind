//! Golden fixtures for the shift reducers (`shift/decide.ts`, `shift/untracked.ts`),
//! dumped from the real TypeScript by `parity/` (`src/gen/shift.ts`).
#![cfg(test)]

mod common;

use common::run;
use serde::{Deserialize, Serialize};
use timo_core::js::ser::to_string;
use timo_core::shift::decide::{
    INITIAL_STATE, ShiftAction, ShiftMonitorState, TickInput, ack_today, expire,
    resolve_shift_window, snooze, tick_shift_monitor,
};
use timo_core::shift::schedule::ShiftSchedule;
use timo_core::shift::untracked::{
    UNTRACKED_INITIAL_STATE, UntrackedNudgeState, UntrackedTickInput, UntrackedTickResult,
    accept_untracked_nudge, snooze_untracked_nudge, tick_untracked_nudge,
};

fn json<T: Serialize>(value: &T) -> Result<String, String> {
    to_string(value).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TickIn {
    schedule: Option<ShiftSchedule>,
    buffer_min: f64,
    state: ShiftMonitorState,
    now_ms: f64,
    time_zone: String,
    nudge_interval_ms: Option<f64>,
}

#[test]
fn fixture_tick_shift_monitor() {
    run(
        "shift",
        "tick_shift_monitor",
        "tickShiftMonitor",
        |i: TickIn| {
            let input = TickInput {
                schedule: i.schedule.as_ref(),
                buffer_min: i.buffer_min,
                state: i.state,
                now: i.now_ms,
                time_zone: &i.time_zone,
                nudge_interval_ms: i.nudge_interval_ms,
            };
            tick_shift_monitor(&input)
                .map_err(|e| e.to_string())
                .and_then(|a| json(&a))
        },
    );
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WindowIn {
    schedule: ShiftSchedule,
    now_ms: f64,
    time_zone: String,
}

#[test]
fn fixture_resolve_shift_window() {
    run(
        "shift",
        "resolve_shift_window",
        "resolveShiftWindow",
        |i: WindowIn| {
            resolve_shift_window(&i.schedule, i.now_ms, &i.time_zone)
                .map_err(|e| e.to_string())
                .and_then(|w| json(&w))
        },
    );
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AckIn {
    state: ShiftMonitorState,
    schedule: ShiftSchedule,
    now_ms: f64,
    time_zone: String,
}

#[test]
fn fixture_ack_today() {
    run("shift", "ack_today", "ackToday", |i: AckIn| {
        ack_today(&i.state, &i.schedule, i.now_ms, &i.time_zone)
            .map_err(|e| e.to_string())
            .and_then(|s| json(&s))
    });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnoozeIn {
    state: ShiftMonitorState,
    now_ms: f64,
    nudge_interval_ms: Option<f64>,
}

#[test]
fn fixture_snooze() {
    run("shift", "snooze", "snooze", |i: SnoozeIn| {
        json(&snooze(&i.state, i.now_ms, i.nudge_interval_ms))
    });
}

#[derive(Deserialize)]
struct StateIn {
    state: ShiftMonitorState,
}

#[test]
fn fixture_expire() {
    run("shift", "expire", "expire", |i: StateIn| {
        json(&expire(&i.state))
    });
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Step {
    #[serde(rename_all = "camelCase")]
    Tick {
        now_ms: f64,
    },
    #[serde(rename_all = "camelCase")]
    Yes {
        now_ms: f64,
    },
    #[serde(rename_all = "camelCase")]
    NotYet {
        now_ms: f64,
    },
    Dismiss,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SequenceIn {
    schedule: ShiftSchedule,
    buffer_min: f64,
    time_zone: String,
    steps: Vec<Step>,
}

/// One recorded step: the action when the step was a tick, and the state after it.
#[derive(Serialize)]
struct TickOut {
    action: ShiftAction,
    state: ShiftMonitorState,
}

#[derive(Serialize)]
struct StateOut {
    state: ShiftMonitorState,
}

/// `ShiftMonitor.tick` / `onUserDecision` (`shift/index.ts`) around the reducer;
/// the same wiring as `parity/src/gen/shift.ts::runSequence`.
fn run_sequence(i: &SequenceIn) -> Result<String, String> {
    const NUDGE_MS: f64 = 300_000.0;
    let mut state = INITIAL_STATE;
    let mut visible = false;
    let mut out = Vec::new();
    for step in &i.steps {
        match step {
            Step::Tick { now_ms } => {
                state.prompting = visible;
                let input = TickInput {
                    schedule: Some(&i.schedule),
                    buffer_min: i.buffer_min,
                    state,
                    now: *now_ms,
                    time_zone: &i.time_zone,
                    nudge_interval_ms: Some(NUDGE_MS),
                };
                let action = tick_shift_monitor(&input).map_err(|e| e.to_string())?;
                match action {
                    ShiftAction::Show { .. } => {
                        visible = true;
                        state.prompting = true;
                    }
                    ShiftAction::Hide => {
                        visible = false;
                        state = expire(&state);
                    }
                    ShiftAction::Schedule { .. } | ShiftAction::Noop => {}
                }
                out.push(json(&TickOut { action, state })?);
            }
            Step::Yes { now_ms } => {
                state = ack_today(&state, &i.schedule, *now_ms, &i.time_zone)
                    .map_err(|e| e.to_string())?;
                visible = false;
                out.push(json(&StateOut { state })?);
            }
            Step::NotYet { now_ms } => {
                state = snooze(&state, *now_ms, Some(NUDGE_MS));
                visible = false;
                out.push(json(&StateOut { state })?);
            }
            Step::Dismiss => {
                visible = false;
                out.push(json(&StateOut { state })?);
            }
        }
    }
    Ok(format!("[{}]", out.join(",")))
}

#[test]
fn fixture_shift_sequence() {
    run(
        "shift",
        "shift_sequence",
        "shiftSequence",
        |i: SequenceIn| run_sequence(&i),
    );
}

#[test]
fn fixture_tick_untracked_nudge() {
    run(
        "shift",
        "tick_untracked_nudge",
        "tickUntrackedNudge",
        |i: UntrackedTickInput| json(&tick_untracked_nudge(&i)),
    );
}

/// A tick of an untracked sequence: the state comes from the steps before it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SequenceTick {
    now: f64,
    in_shift: bool,
    tracking: bool,
    idle_seconds: f64,
    attention_busy: bool,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum UStep {
    Tick {
        input: SequenceTick,
    },
    Accept,
    #[serde(rename_all = "camelCase")]
    Snooze {
        now_ms: f64,
        snooze_ms: Option<f64>,
    },
}

#[derive(Deserialize)]
struct USequenceIn {
    steps: Vec<UStep>,
}

fn run_untracked_sequence(i: &USequenceIn) -> Result<String, String> {
    let mut state = UNTRACKED_INITIAL_STATE;
    let mut out = Vec::new();
    for step in &i.steps {
        match step {
            UStep::Tick { input } => {
                let result: UntrackedTickResult = tick_untracked_nudge(&UntrackedTickInput {
                    state,
                    now: input.now,
                    in_shift: input.in_shift,
                    tracking: input.tracking,
                    idle_seconds: input.idle_seconds,
                    attention_busy: input.attention_busy,
                });
                state = result.state;
                out.push(json(&result)?);
            }
            UStep::Accept => {
                state = accept_untracked_nudge(&state);
                out.push(json(&UStateOut { state })?);
            }
            UStep::Snooze { now_ms, snooze_ms } => {
                state = snooze_untracked_nudge(&state, *now_ms, *snooze_ms);
                out.push(json(&UStateOut { state })?);
            }
        }
    }
    Ok(format!("[{}]", out.join(",")))
}

#[derive(Serialize)]
struct UStateOut {
    state: UntrackedNudgeState,
}

#[test]
fn fixture_untracked_sequence() {
    run(
        "shift",
        "untracked_sequence",
        "untrackedSequence",
        |i: USequenceIn| run_untracked_sequence(&i),
    );
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct USnoozeIn {
    state: UntrackedNudgeState,
    now_ms: f64,
    snooze_ms: Option<f64>,
}

#[test]
fn fixture_snooze_untracked_nudge() {
    run(
        "shift",
        "snooze_untracked_nudge",
        "snoozeUntrackedNudge",
        |i: USnoozeIn| json(&snooze_untracked_nudge(&i.state, i.now_ms, i.snooze_ms)),
    );
}

#[derive(Deserialize)]
struct UStateIn {
    state: UntrackedNudgeState,
}

#[test]
fn fixture_accept_untracked_nudge() {
    run(
        "shift",
        "accept_untracked_nudge",
        "acceptUntrackedNudge",
        |i: UStateIn| json(&accept_untracked_nudge(&i.state)),
    );
}
