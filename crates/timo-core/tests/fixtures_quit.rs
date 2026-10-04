//! Golden fixtures for the quit-cleanup runner, dumped from the real TypeScript
//! by `parity/src/gen/quit.ts`.
#![cfg(test)]

mod common;

use std::collections::HashSet;

use serde::{Deserialize, Serialize};
use timo_core::js::ser::to_string;
use timo_core::quit_cleanup::{
    BeforeQuit, OpOutcome, QuitCleanupRunner, QuitEffect, QuitLogLevel, QuitLogMeta, QuitOp,
    before_quit_decision,
};

fn json<T: Serialize>(value: &T) -> Result<String, String> {
    to_string(value).map_err(|e| e.to_string())
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Mode {
    Deferred,
    SyncThrow,
    Value,
}

#[derive(Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
enum Event {
    Run { reason: String },
    Finish { op: u64, how: How },
    Fire { op: u64 },
    Invalidate,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum How {
    Resolve,
    Reject,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Input {
    timeout_ms: Option<f64>,
    flush_logs: bool,
    activity: Throws,
    get_timer: Throws,
    prepare: Mode,
    sync: Mode,
    prefs: Mode,
    logs: Mode,
    events: Vec<Event>,
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
enum Throws {
    Ok,
    Throw,
}

#[derive(Serialize)]
#[serde(tag = "e", rename_all = "camelCase")]
enum Trace {
    Log {
        level: QuitLogLevel,
        message: &'static str,
        meta: QuitLogMeta,
    },
    Op {
        id: u64,
        op: &'static str,
        #[serde(skip_serializing_if = "Option::is_none")]
        reason: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        limit: Option<&'static str>,
    },
    Arm {
        id: u64,
        ms: f64,
    },
    Clear {
        id: u64,
    },
}

#[derive(Serialize)]
struct Step {
    joined: Option<bool>,
    trace: Vec<Trace>,
    completed: bool,
}

struct Host<'a> {
    input: &'a Input,
    runner: QuitCleanupRunner,
    trace: Vec<Trace>,
    pending: HashSet<u64>,
    live: HashSet<u64>,
}

fn failed(name: &str) -> OpOutcome {
    OpOutcome::ThrewSync(format!("Error: {name} failed"))
}

impl Host<'_> {
    fn op(&mut self, id: u64, op: &'static str) {
        self.trace.push(Trace::Op {
            id,
            op,
            reason: None,
            limit: None,
        });
    }

    fn arm(&mut self, id: u64, ms: f64) {
        self.live.insert(id);
        self.trace.push(Trace::Arm { id, ms });
    }

    /// Sync throw, or arm the timer and either resolve now or wait.
    fn armed(&mut self, run: (u64, f64), mode: Mode, name: &str) -> Option<OpOutcome> {
        let (id, ms) = run;
        if mode == Mode::SyncThrow {
            return Some(failed(name));
        }
        self.arm(id, ms);
        if mode == Mode::Value {
            Some(OpOutcome::Resolved)
        } else {
            self.pending.insert(id);
            None
        }
    }

    fn run_op(&mut self, run: (u64, f64), op: QuitOp, reason: String) -> Option<OpOutcome> {
        let (id, ms) = run;
        match op {
            QuitOp::FlushPartialActivity => {
                self.op(id, "flushPartialActivity");
                Some(if self.input.activity == Throws::Throw {
                    failed("flushPartialActivity")
                } else {
                    OpOutcome::Resolved
                })
            }
            QuitOp::PrepareForQuit => {
                self.op(id, "getTimer");
                if self.input.get_timer == Throws::Throw {
                    return Some(failed("getTimer"));
                }
                self.trace.push(Trace::Op {
                    id,
                    op: "prepareForQuit",
                    reason: Some(reason),
                    limit: None,
                });
                self.armed((id, ms), self.input.prepare, "prepareForQuit")
            }
            QuitOp::FlushUnsynced => {
                self.trace.push(Trace::Op {
                    id,
                    op: "flushUnsynced",
                    reason: None,
                    limit: Some("Infinity"),
                });
                self.armed((id, ms), self.input.sync, "flushUnsynced")
            }
            QuitOp::FlushPreferences => {
                self.op(id, "flushPreferences");
                self.armed((id, ms), self.input.prefs, "flushPreferences")
            }
            QuitOp::FlushLogs { call } => {
                if !call {
                    self.arm(id, ms);
                    return Some(OpOutcome::Resolved);
                }
                self.op(id, "flushLogs");
                self.armed((id, ms), self.input.logs, "flushLogs")
            }
        }
    }

    fn perform(&mut self, effects: Vec<QuitEffect>) {
        for effect in effects {
            match effect {
                QuitEffect::Log {
                    level,
                    message,
                    meta,
                } => {
                    self.trace.push(Trace::Log {
                        level,
                        message,
                        meta,
                    });
                }
                QuitEffect::ClearTimer { id } => {
                    self.live.remove(&id);
                    self.trace.push(Trace::Clear { id });
                }
                QuitEffect::Run {
                    id,
                    op,
                    reason,
                    timeout_ms,
                } => {
                    if let Some(outcome) = self.run_op((id, timeout_ms.unwrap_or(0.0)), op, reason)
                    {
                        let next = self.runner.op_finished(id, &outcome);
                        self.perform(next);
                    }
                }
            }
        }
    }

    fn apply(&mut self, event: Event) -> Option<bool> {
        match event {
            Event::Run { reason } => {
                let start = self.runner.run(&reason);
                self.perform(start.effects);
                return Some(start.joined);
            }
            Event::Finish { op, how } => {
                if self.pending.remove(&op) {
                    let outcome = match how {
                        How::Resolve => OpOutcome::Resolved,
                        How::Reject => OpOutcome::Rejected("Error: db busy".to_owned()),
                    };
                    let next = self.runner.op_finished(op, &outcome);
                    self.perform(next);
                }
            }
            Event::Fire { op } => {
                if self.live.remove(&op) {
                    let next = self.runner.timer_fired(op);
                    self.perform(next);
                }
            }
            Event::Invalidate => self.runner.invalidate(),
        }
        None
    }
}

#[test]
fn fixture_runner() {
    common::run("quit", "runner", "runner", |mut input: Input| {
        let events = std::mem::take(&mut input.events);
        let mut host = Host {
            runner: QuitCleanupRunner::new(input.timeout_ms, input.flush_logs),
            input: &input,
            trace: Vec::new(),
            pending: HashSet::new(),
            live: HashSet::new(),
        };
        let mut steps = Vec::new();
        for event in events {
            let joined = host.apply(event);
            steps.push(Step {
                joined,
                trace: std::mem::take(&mut host.trace),
                completed: host.runner.has_completed(),
            });
        }
        json(&steps)
    });
}

#[derive(Deserialize)]
struct Completed {
    completed: bool,
}

#[test]
fn fixture_before_quit() {
    common::run("quit", "before_quit", "beforeQuit", |i: Completed| {
        let mut calls = vec!["markQuitting"];
        if before_quit_decision(i.completed) == BeforeQuit::PreventAndCleanUp {
            // `app.quit()` follows once the cleanup promise settles (a later microtask,
            // after the TypeScript spec has recorded its calls).
            calls.extend(["preventDefault", "runCleanup:quit"]);
        }
        json(&calls)
    });
}
