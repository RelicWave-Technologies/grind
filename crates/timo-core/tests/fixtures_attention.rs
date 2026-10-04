//! Golden fixtures for the prompt services, dumped from the real TypeScript by
//! `parity/src/gen/attention.ts`.
#![cfg(test)]

mod attention_support;
mod common;

use attention_support::{Call, Predicate, Rig};
use serde::{Deserialize, Serialize};
use timo_core::js::ser::to_string;
use timo_core::prompt_reachability::{PromptGateInput, decide_prompt_gate};
use timo_core::tracking_attention::{AttentionPrompt, AwayInfo, IdleWarningInfo, PermissionIntent};

fn json<T: Serialize>(value: &T) -> Result<String, String> {
    to_string(value).map_err(|e| e.to_string())
}

#[test]
fn fixture_decide_prompt_gate() {
    common::run(
        "attention",
        "decide_prompt_gate",
        "decidePromptGate",
        |i: PromptGateInput| json(&decide_prompt_gate(&i)),
    );
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Resume {
    None,
    Flag,
    AsyncFlag,
    Never,
    Always,
    Throws,
    AsyncThrows,
}

impl Resume {
    fn predicate(self) -> Option<Predicate> {
        match self {
            Self::None => None,
            Self::Flag | Self::AsyncFlag => Some(Predicate::Flag),
            Self::Never => Some(Predicate::Never),
            Self::Always => Some(Predicate::Always),
            Self::Throws | Self::AsyncThrows => Some(Predicate::Throws),
        }
    }
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Target {
    Current,
    Stale,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ClearTarget {
    Current,
    Stale,
    None,
    Empty,
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum Event {
    RequestIdleWarning(IdleWarningInfo),
    #[serde(rename_all = "camelCase")]
    RequestIdle {
        idle_started_at: f64,
    },
    ClearIdleWarning,
    BeginMachineAway,
    RequestAway(AwayInfo),
    RequestPermission {
        intent: PermissionIntent,
    },
    Yield {
        target: Target,
        resume: Resume,
    },
    RestoreActive,
    ReleaseUnreachable {
        reason: String,
    },
    Clear {
        target: ClearTarget,
    },
    IsPermissionActive,
    FireReady,
    Tick,
    Flush,
    SetGranted {
        value: bool,
    },
    SetTopThrows {
        value: bool,
    },
    SetOnTop {
        value: bool,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    logging: bool,
    resume_poll_ms: Option<f64>,
    events: Vec<Event>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum Ret {
    Nothing(()),
    Flag(bool),
    Prompt(AttentionPrompt),
}

#[derive(Serialize)]
struct Step {
    ret: Ret,
    calls: Vec<Call>,
    prompt: AttentionPrompt,
}

fn current_id(rig: &Rig) -> String {
    rig.coordinator
        .get()
        .prompt_id()
        .unwrap_or("no-prompt")
        .to_owned()
}

fn id_of(rig: &Rig, target: Target) -> String {
    match target {
        Target::Stale => "older-prompt".to_owned(),
        Target::Current => current_id(rig),
    }
}

fn apply(rig: &mut Rig, event: Event) -> Ret {
    match event {
        Event::RequestIdleWarning(info) => Ret::Flag(rig.coordinator.request_idle_warning(info)),
        Event::RequestIdle { idle_started_at } => {
            Ret::Flag(rig.coordinator.request_idle(idle_started_at))
        }
        Event::ClearIdleWarning => Ret::Flag(rig.coordinator.clear_idle_warning()),
        Event::BeginMachineAway => {
            rig.coordinator.begin_machine_away();
            Ret::Nothing(())
        }
        Event::RequestAway(info) => Ret::Flag(rig.coordinator.request_away(info)),
        Event::RequestPermission { intent } => {
            Ret::Prompt(rig.coordinator.request_permission(intent))
        }
        Event::Yield { target, resume } => {
            let id = id_of(rig, target);
            Ret::Flag(rig.yield_to_settings(&id, resume.predicate()))
        }
        Event::RestoreActive => Ret::Flag(rig.coordinator.restore_active()),
        Event::ReleaseUnreachable { reason } => {
            Ret::Flag(rig.coordinator.release_unreachable(&reason))
        }
        Event::Clear { target } => {
            let id = match target {
                ClearTarget::None => None,
                ClearTarget::Empty => Some(String::new()),
                ClearTarget::Stale => Some("older-prompt".to_owned()),
                ClearTarget::Current => Some(current_id(rig)),
            };
            Ret::Flag(rig.coordinator.clear(id.as_deref()))
        }
        Event::IsPermissionActive => Ret::Flag(rig.coordinator.is_permission_active()),
        other => apply_quiet(rig, &other),
    }
}

/// The events that return nothing.
fn apply_quiet(rig: &mut Rig, event: &Event) -> Ret {
    match *event {
        Event::FireReady => rig.fire_ready(),
        Event::Tick => rig.tick(),
        Event::Flush => rig.flush(),
        Event::SetGranted { value } => rig.granted = value,
        Event::SetTopThrows { value } => rig.coordinator.env_mut().throw_on_top = value,
        Event::SetOnTop { value } => rig.coordinator.env_mut().on_top = value,
        _ => {}
    }
    Ret::Nothing(())
}

fn run(input: Input) -> Vec<Step> {
    let mut rig = Rig::with_poll(input.logging, input.resume_poll_ms);
    let mut steps = Vec::new();
    for event in input.events {
        let ret = apply(&mut rig, event);
        let calls = std::mem::take(&mut rig.coordinator.env_mut().calls);
        steps.push(Step {
            ret,
            calls,
            prompt: rig.coordinator.get().clone(),
        });
    }
    // The TypeScript settles every pending promise once more at the end; nothing
    // is recorded after it.
    steps
}

#[test]
fn fixture_coordinator() {
    common::run("attention", "coordinator", "coordinator", |i: Input| {
        json(&run(i))
    });
}
