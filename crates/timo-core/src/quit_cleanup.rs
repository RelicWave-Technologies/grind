//! Port of `legacy/agent/src/main/services/quitCleanup.ts`: the quit cleanup
//! runner (five steps, each bounded by a timeout) and the `before-quit`
//! decision.
//!
//! The TypeScript awaits real promises raced against `setTimeout`. This port is
//! the same sequence as a state machine: [`QuitCleanupRunner::run`] and the two
//! event methods return the [`QuitEffect`]s to perform, in the order the
//! TypeScript performs them, and the host reports back how each operation
//! ended ([`QuitCleanupRunner::op_finished`]) or that its timer fired
//! ([`QuitCleanupRunner::timer_fired`]). A step that times out is abandoned, not
//! cancelled: its late result is ignored, except that the TypeScript still
//! calls `clearTimer` on it.

use serde::Serialize;

/// `QUIT_CLEANUP_TIMEOUT_MS`.
pub const QUIT_CLEANUP_TIMEOUT_MS: f64 = 5_000.0;

/// An operation the host performs for the runner.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum QuitOp {
    /// `deps.flushPartialActivity()` (synchronous, no timeout).
    FlushPartialActivity,
    /// `deps.getTimer()` then `timer.prepareForQuit(reason)`.
    PrepareForQuit,
    /// `timer.flushUnsynced(Number.POSITIVE_INFINITY)` on the timer from before.
    FlushUnsynced,
    /// `deps.flushPreferences()`.
    FlushPreferences,
    /// `deps.flushLogs?.()`; `call` is false when no `flushLogs` was injected.
    FlushLogs { call: bool },
}

/// How an operation ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OpOutcome {
    /// Returned (or its promise resolved).
    Resolved,
    /// Its promise rejected; the text is `String(err)`.
    Rejected(String),
    /// It threw before returning a promise (no timer had been armed yet); the
    /// text is `String(err)`.
    ThrewSync(String),
}

/// Log level of `QuitCleanupLogger`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum QuitLogLevel {
    Debug,
    Warn,
}

/// The `meta` argument of a log call.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum QuitLogMeta {
    Reason { reason: String },
    Failed { reason: String, err: String },
    TimedOut { label: &'static str, ms: f64 },
}

/// Something the host must do, in order.
#[derive(Debug, Clone, PartialEq)]
pub enum QuitEffect {
    /// `logger.debug` / `logger.warn`.
    Log {
        level: QuitLogLevel,
        message: &'static str,
        meta: QuitLogMeta,
    },
    /// Call `op` (with `reason` for `PrepareForQuit`), then, when `timeout_ms`
    /// is given, arm a timer of that length. Report with `op_finished(id, ..)`
    /// and, if the timer fires first, `timer_fired(id)`.
    Run {
        id: u64,
        op: QuitOp,
        reason: String,
        timeout_ms: Option<f64>,
    },
    /// `clearTimer(timer)` for the timer armed with op `id`.
    ClearTimer { id: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stage {
    Activity,
    Prepare,
    Sync,
    Preferences,
    Logs,
}

#[derive(Debug, Clone)]
struct Running {
    reason: String,
    stage: Stage,
    /// The op being awaited, and whether its timer is still armed.
    op: u64,
    timer_live: bool,
}

/// Port of `QuitCleanupRunner`.
#[derive(Debug)]
pub struct QuitCleanupRunner {
    has_flush_logs: bool,
    timeout_ms: f64,
    completed: bool,
    running: Option<Running>,
    next_op: u64,
    /// Ops whose step timed out: their late result only clears the timer.
    abandoned: Vec<u64>,
}

/// What `run` did.
#[derive(Debug, Clone, PartialEq)]
pub struct RunStart {
    /// A cleanup was already in flight: the same promise is returned.
    pub joined: bool,
    pub effects: Vec<QuitEffect>,
}

impl QuitCleanupRunner {
    /// `new QuitCleanupRunner(deps)`: `timeout_ms` defaults to
    /// [`QUIT_CLEANUP_TIMEOUT_MS`]; `has_flush_logs` is `deps.flushLogs`.
    #[must_use]
    pub fn new(timeout_ms: Option<f64>, has_flush_logs: bool) -> Self {
        Self {
            has_flush_logs,
            timeout_ms: timeout_ms.unwrap_or(QUIT_CLEANUP_TIMEOUT_MS),
            completed: false,
            running: None,
            next_op: 0,
            abandoned: Vec::new(),
        }
    }

    /// `hasCompleted()`.
    #[must_use]
    pub fn has_completed(&self) -> bool {
        self.completed
    }

    /// `invalidate()`.
    pub fn invalidate(&mut self) {
        self.completed = false;
    }

    /// `run(reason)`.
    pub fn run(&mut self, reason: &str) -> RunStart {
        if self.running.is_some() {
            return RunStart {
                joined: true,
                effects: Vec::new(),
            };
        }
        self.completed = false;
        let mut effects = vec![QuitEffect::Log {
            level: QuitLogLevel::Debug,
            message: "quit cleanup started",
            meta: QuitLogMeta::Reason {
                reason: reason.to_owned(),
            },
        }];
        self.start(reason, Stage::Activity, &mut effects);
        RunStart {
            joined: false,
            effects,
        }
    }

    /// An operation ended.
    pub fn op_finished(&mut self, id: u64, outcome: &OpOutcome) -> Vec<QuitEffect> {
        let mut effects = Vec::new();
        if let Some(at) = self.abandoned.iter().position(|a| *a == id) {
            // Late result of a step that already timed out.
            self.abandoned.remove(at);
            if !matches!(outcome, OpOutcome::ThrewSync(_)) {
                effects.push(QuitEffect::ClearTimer { id });
            }
            return effects;
        }
        let Some(running) = self.running.as_ref().filter(|r| r.op == id) else {
            return effects;
        };
        let (stage, timer_live) = (running.stage, running.timer_live);
        if timer_live && !matches!(outcome, OpOutcome::ThrewSync(_)) && stage != Stage::Activity {
            effects.push(QuitEffect::ClearTimer { id });
        }
        self.after(stage, outcome, &mut effects);
        effects
    }

    /// The timer armed with op `id` fired before the op ended.
    pub fn timer_fired(&mut self, id: u64) -> Vec<QuitEffect> {
        let mut effects = Vec::new();
        let Some(running) = self.running.as_ref().filter(|r| r.op == id && r.timer_live) else {
            return effects;
        };
        let stage = running.stage;
        self.abandoned.push(id);
        effects.push(QuitEffect::Log {
            level: QuitLogLevel::Warn,
            message: "quit cleanup timed out",
            meta: QuitLogMeta::TimedOut {
                label: label_of(stage),
                ms: self.timeout_ms,
            },
        });
        // The race resolved with `null`: carry on as if the step succeeded.
        self.after(stage, &OpOutcome::Resolved, &mut effects);
        effects
    }

    /// Emit the `Run` for `stage` (or finish).
    fn start(&mut self, reason: &str, stage: Stage, fx: &mut Vec<QuitEffect>) {
        let op = match stage {
            Stage::Activity => QuitOp::FlushPartialActivity,
            Stage::Prepare => QuitOp::PrepareForQuit,
            Stage::Sync => QuitOp::FlushUnsynced,
            Stage::Preferences => QuitOp::FlushPreferences,
            Stage::Logs => QuitOp::FlushLogs {
                call: self.has_flush_logs,
            },
        };
        let id = self.next_op;
        self.next_op += 1;
        let timed = stage != Stage::Activity;
        self.running = Some(Running {
            reason: reason.to_owned(),
            stage,
            op: id,
            timer_live: timed,
        });
        fx.push(QuitEffect::Run {
            id,
            op,
            reason: reason.to_owned(),
            timeout_ms: timed.then_some(self.timeout_ms),
        });
    }

    /// The step `stage` ended with `outcome`; move to the next one.
    fn after(&mut self, stage: Stage, outcome: &OpOutcome, fx: &mut Vec<QuitEffect>) {
        let reason = self
            .running
            .as_ref()
            .map(|r| r.reason.clone())
            .unwrap_or_default();
        let failure = match outcome {
            OpOutcome::Resolved => None,
            OpOutcome::Rejected(err) | OpOutcome::ThrewSync(err) => Some(err.clone()),
        };
        let failed_with = |message: &'static str| {
            failure
                .clone()
                .map(|err| warn_effect(&reason, message, err))
        };
        match stage {
            Stage::Activity => {
                fx.extend(failed_with("quit cleanup activity failed"));
                self.start(&reason, Stage::Prepare, fx);
            }
            // A failure of either timer step ends the timer block.
            Stage::Prepare | Stage::Sync => {
                let failed = failed_with("quit cleanup timer failed");
                let next = if failed.is_some() || stage == Stage::Sync {
                    Stage::Preferences
                } else {
                    Stage::Sync
                };
                fx.extend(failed);
                self.start(&reason, next, fx);
            }
            Stage::Preferences => {
                fx.extend(failed_with("quit cleanup preferences failed"));
                fx.push(QuitEffect::Log {
                    level: QuitLogLevel::Debug,
                    message: "quit cleanup finished",
                    meta: QuitLogMeta::Reason {
                        reason: reason.clone(),
                    },
                });
                self.start(&reason, Stage::Logs, fx);
            }
            Stage::Logs => {
                // Logging is best-effort: a failure is swallowed.
                self.running = None;
                self.completed = true;
            }
        }
    }
}

/// `logger.warn(message, { reason, err })`.
fn warn_effect(reason: &str, message: &'static str, err: String) -> QuitEffect {
    QuitEffect::Log {
        level: QuitLogLevel::Warn,
        message,
        meta: QuitLogMeta::Failed {
            reason: reason.to_owned(),
            err,
        },
    }
}

fn label_of(stage: Stage) -> &'static str {
    match stage {
        Stage::Activity => "activity",
        Stage::Prepare => "timer finalization",
        Stage::Sync => "timer sync",
        Stage::Preferences => "preferences",
        Stage::Logs => "logs",
    }
}

/// What the `before-quit` listener of `registerGracefulQuitHandler` decides.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BeforeQuit {
    /// Cleanup already completed: let the quit proceed.
    Proceed,
    /// `event.preventDefault()`, run the cleanup with reason `'quit'`, then call
    /// `app.quit()` again once it settles (success or failure).
    PreventAndCleanUp,
}

/// Port of the `before-quit` listener's decision. `markQuitting` runs first on
/// every `before-quit`, whichever way this returns.
#[must_use]
pub fn before_quit_decision(has_cleanup_completed: bool) -> BeforeQuit {
    if has_cleanup_completed {
        BeforeQuit::Proceed
    } else {
        BeforeQuit::PreventAndCleanUp
    }
}
