//! Golden fixtures for the idle services, dumped from the real TypeScript by
//! `parity/src/gen/idle.ts`.
#![cfg(test)]

mod common;

use serde::{Deserialize, Serialize};
use timo_core::idle::{
    HandlerOutcome, IdleEffect, IdleInputs, IdleMonitor, IdleSnapshot, IdleTickInput,
    compute_idle_start, should_prompt_idle,
};
use timo_core::js::ser::to_string;

fn json<T: Serialize>(value: &T) -> Result<String, String> {
    to_string(value).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ShouldPrompt {
    is_running: bool,
    idle_seconds: f64,
    threshold_sec: f64,
    prompting: bool,
}

#[test]
fn fixture_should_prompt_idle() {
    common::run(
        "idle",
        "should_prompt_idle",
        "shouldPromptIdle",
        |i: ShouldPrompt| {
            json(&should_prompt_idle(&IdleInputs {
                is_running: i.is_running,
                idle_seconds: i.idle_seconds,
                threshold_sec: i.threshold_sec,
                prompting: i.prompting,
            }))
        },
    );
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdleStart {
    now_ms: f64,
    idle_seconds: f64,
}

#[test]
fn fixture_compute_idle_start() {
    common::run(
        "idle",
        "compute_idle_start",
        "computeIdleStart",
        |i: IdleStart| json(&compute_idle_start(i.now_ms, i.idle_seconds)),
    );
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Outcome {
    Accept,
    Reject,
    Throw,
}

impl From<Outcome> for HandlerOutcome {
    fn from(o: Outcome) -> Self {
        match o {
            Outcome::Accept => Self::Accepted,
            Outcome::Reject => Self::Rejected,
            Outcome::Throw => Self::Failed,
        }
    }
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum Event {
    Tick {
        now: f64,
        idle: f64,
        running: bool,
        paused: bool,
        prot: bool,
        threshold: f64,
        warning: Option<f64>,
    },
    ResolveWarning {
        now: f64,
        result: Outcome,
    },
    ResolveIdle {
        result: Outcome,
    },
    NoteActivity,
    Suspend,
    Resume,
    Resolve,
    IsPrompting,
}

#[derive(Deserialize)]
struct Input {
    events: Vec<Event>,
}

#[derive(Serialize)]
struct Step {
    ret: Option<bool>,
    effects: Vec<IdleEffect>,
    state: IdleSnapshot,
}

fn apply(monitor: &mut IdleMonitor, event: &Event) -> (Option<bool>, Vec<IdleEffect>) {
    let effects = match *event {
        Event::Tick {
            now,
            idle,
            running,
            paused,
            prot,
            threshold,
            warning,
        } => monitor.tick(&IdleTickInput {
            is_protected: prot,
            accruing: running && !paused,
            idle_seconds: idle,
            now,
            threshold_sec: threshold,
            warning_seconds: warning,
        }),
        Event::ResolveWarning { now, result } => monitor.warning_settled(result.into(), now),
        Event::ResolveIdle { result } => monitor.idle_settled(result.into()),
        Event::NoteActivity => monitor.note_activity(),
        Event::Suspend => monitor.suspend(),
        Event::Resume => monitor.resume(),
        Event::Resolve => monitor.resolve(),
        Event::IsPrompting => return (Some(monitor.is_prompting()), Vec::new()),
    };
    (None, effects)
}

fn run_monitor(input: Input) -> Vec<Step> {
    let mut monitor = IdleMonitor::new();
    input
        .events
        .into_iter()
        .map(|e| {
            let (ret, effects) = apply(&mut monitor, &e);
            Step {
                ret,
                effects,
                state: monitor.snapshot(),
            }
        })
        .collect()
}

#[test]
fn fixture_idle_monitor() {
    common::run("idle", "idle_monitor", "idleMonitor", |i: Input| {
        json(&run_monitor(i))
    });
}
