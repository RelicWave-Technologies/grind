//! Port of `legacy/agent/src/main/services/idle/monitor.ts`, as a pure reducer.
//!
//! The TypeScript `IdleMonitor` polls `powerMonitor.getSystemIdleTime()` on an
//! interval and awaits two async handlers. Here every outside reading arrives as
//! an argument (the idle seconds, the device clock, the config getters, whether
//! the timer is accruing) and every outside action leaves as an [`IdleEffect`]
//! in the order the TypeScript performs it. The two awaits become two events,
//! [`IdleMonitor::warning_settled`] and [`IdleMonitor::idle_settled`], so the
//! continuation after an await runs against whatever state other events (a
//! `noteActivity`, a `suspend`) left behind, exactly as it does in JavaScript.

use serde::Serialize;

use crate::js::math::mul;
use crate::js::number::{add, max, sub};

use super::decide::compute_idle_start;

/// Port of `IdlePhase`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum IdlePhase {
    #[serde(rename = "NONE")]
    None,
    #[serde(rename = "WARNING")]
    Warning,
    #[serde(rename = "IDLE_PENDING")]
    IdlePending,
    #[serde(rename = "IDLE_PROMPT")]
    IdlePrompt,
}

/// Everything one poll reads from outside, sampled at the same instant.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IdleTickInput {
    /// `isProtected()`.
    pub is_protected: bool,
    /// `status.state === 'RUNNING' && !status.paused`.
    pub accruing: bool,
    /// `powerMonitor.getSystemIdleTime()`.
    pub idle_seconds: f64,
    /// `Date.now()` (the device clock).
    pub now: f64,
    /// `getIdleThresholdSec()`.
    pub threshold_sec: f64,
    /// `getIdleWarningSeconds()` (`None` when the warning is disabled).
    pub warning_seconds: Option<f64>,
}

/// How an awaited handler ended: `true`, `false`, or a throw.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HandlerOutcome {
    Accepted,
    Rejected,
    Failed,
}

/// An action the monitor performs outside itself, in order.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "e", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum IdleEffect {
    /// `await handlers.onWarning({ idleStartedAt, deadlineAt })`.
    Warning {
        idle_started_at: f64,
        deadline_at: f64,
    },
    /// `handlers.onWarningCancelled()`.
    WarningCancelled,
    /// `await handlers.onIdle(idleStartedAt)`.
    Idle { idle_started_at: f64 },
    /// `setTimeout(tick, delay)`.
    Arm { delay: f64 },
    /// `clearTimeout(deadlineTimer)`.
    Clear,
}

/// The monitor's private fields, for fixtures and tests.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleSnapshot {
    pub phase: IdlePhase,
    pub suspended: bool,
    pub ticking: bool,
    pub idle_started_at: f64,
    pub warning_trigger_sec: f64,
    pub threshold_sec: f64,
    pub deadline_at: f64,
    pub timer_set: bool,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Awaiting {
    Nothing,
    Warning { deadline_at: f64 },
    Idle,
}

/// Port of `IdleMonitor`.
#[derive(Debug, Clone)]
pub struct IdleMonitor {
    phase: IdlePhase,
    suspended: bool,
    ticking: bool,
    idle_started_at: f64,
    warning_trigger_sec: f64,
    threshold_sec: f64,
    deadline_at: f64,
    deadline_timer: bool,
    awaiting: Awaiting,
}

impl Default for IdleMonitor {
    fn default() -> Self {
        Self::new()
    }
}

impl IdleMonitor {
    #[must_use]
    pub fn new() -> Self {
        Self {
            phase: IdlePhase::None,
            suspended: false,
            ticking: false,
            idle_started_at: 0.0,
            warning_trigger_sec: 0.0,
            threshold_sec: 0.0,
            deadline_at: 0.0,
            deadline_timer: false,
            awaiting: Awaiting::Nothing,
        }
    }

    #[must_use]
    pub fn snapshot(&self) -> IdleSnapshot {
        IdleSnapshot {
            phase: self.phase,
            suspended: self.suspended,
            ticking: self.ticking,
            idle_started_at: self.idle_started_at,
            warning_trigger_sec: self.warning_trigger_sec,
            threshold_sec: self.threshold_sec,
            deadline_at: self.deadline_at,
            timer_set: self.deadline_timer,
        }
    }

    /// `isPrompting()`.
    #[must_use]
    pub fn is_prompting(&self) -> bool {
        self.phase != IdlePhase::None
    }

    /// One poll (`tick`): the interval, or the armed deadline timer firing.
    /// Ignored while a previous tick is still awaiting a handler.
    pub fn tick(&mut self, input: &IdleTickInput) -> Vec<IdleEffect> {
        if self.ticking {
            return Vec::new();
        }
        self.ticking = true;
        let mut effects = Vec::new();
        self.tick_once(input, &mut effects);
        effects
    }

    /// Ends the tick when it did not stop at an await.
    fn finish(&mut self) {
        self.ticking = false;
    }

    fn tick_once(&mut self, input: &IdleTickInput, fx: &mut Vec<IdleEffect>) {
        if self.suspended {
            return self.finish();
        }
        if self.phase == IdlePhase::IdlePending {
            return self.present_idle_prompt(fx);
        }
        if self.phase == IdlePhase::IdlePrompt {
            return self.finish();
        }
        if input.is_protected || !input.accruing {
            self.cancel_warning(fx);
            return self.finish();
        }
        if self.phase == IdlePhase::Warning {
            return self.tick_in_warning(input, fx);
        }
        if input.idle_seconds >= input.threshold_sec {
            let start = compute_idle_start(input.now, input.idle_seconds);
            return self.begin_idle_pause(start, fx);
        }
        self.maybe_warn(input, fx);
    }

    fn tick_in_warning(&mut self, input: &IdleTickInput, fx: &mut Vec<IdleEffect>) {
        if input.idle_seconds < self.warning_trigger_sec {
            self.cancel_warning(fx);
            return self.finish();
        }
        if input.now >= self.deadline_at || input.idle_seconds >= self.threshold_sec {
            return self.begin_idle_pause(self.idle_started_at, fx);
        }
        self.finish();
    }

    fn maybe_warn(&mut self, input: &IdleTickInput, fx: &mut Vec<IdleEffect>) {
        let Some(warning_seconds) = input.warning_seconds else {
            return self.finish();
        };
        let trigger = sub(input.threshold_sec, warning_seconds);
        if input.idle_seconds < trigger {
            return self.finish();
        }
        let idle_started_at = compute_idle_start(input.now, input.idle_seconds);
        let deadline_at = add(idle_started_at, mul(input.threshold_sec, 1000.0));
        self.phase = IdlePhase::Warning;
        self.idle_started_at = idle_started_at;
        self.warning_trigger_sec = trigger;
        self.threshold_sec = input.threshold_sec;
        self.deadline_at = deadline_at;
        self.awaiting = Awaiting::Warning { deadline_at };
        fx.push(IdleEffect::Warning {
            idle_started_at,
            deadline_at,
        });
    }

    fn begin_idle_pause(&mut self, idle_started_at: f64, fx: &mut Vec<IdleEffect>) {
        self.clear_deadline(fx);
        self.phase = IdlePhase::IdlePending;
        self.idle_started_at = idle_started_at;
        self.present_idle_prompt(fx);
    }

    fn present_idle_prompt(&mut self, fx: &mut Vec<IdleEffect>) {
        self.awaiting = Awaiting::Idle;
        fx.push(IdleEffect::Idle {
            idle_started_at: self.idle_started_at,
        });
    }

    /// The `await handlers.onWarning(...)` finished. `now` is `Date.now()` at
    /// that moment.
    pub fn warning_settled(&mut self, outcome: HandlerOutcome, now: f64) -> Vec<IdleEffect> {
        let mut fx = Vec::new();
        let Awaiting::Warning { deadline_at } = self.awaiting else {
            return fx;
        };
        self.awaiting = Awaiting::Nothing;
        if outcome == HandlerOutcome::Accepted {
            // Uses the deadline captured when the warning was raised, not the
            // field, which another event may have reset meanwhile.
            self.clear_deadline(&mut fx);
            self.deadline_timer = true;
            fx.push(IdleEffect::Arm {
                delay: max(0.0, sub(deadline_at, now)),
            });
        } else {
            self.reset(&mut fx);
        }
        self.finish();
        fx
    }

    /// The `await handlers.onIdle(...)` finished.
    pub fn idle_settled(&mut self, outcome: HandlerOutcome) -> Vec<IdleEffect> {
        if self.awaiting != Awaiting::Idle {
            return Vec::new();
        }
        self.awaiting = Awaiting::Nothing;
        self.phase = if outcome == HandlerOutcome::Accepted {
            IdlePhase::IdlePrompt
        } else {
            IdlePhase::IdlePending
        };
        self.finish();
        Vec::new()
    }

    /// `noteActivity()`: tracked input only cancels a warning.
    pub fn note_activity(&mut self) -> Vec<IdleEffect> {
        let mut fx = Vec::new();
        self.cancel_warning(&mut fx);
        fx
    }

    /// `suspend()`.
    pub fn suspend(&mut self) -> Vec<IdleEffect> {
        let mut fx = Vec::new();
        self.suspended = true;
        if self.phase == IdlePhase::Warning {
            fx.push(IdleEffect::WarningCancelled);
        }
        self.reset(&mut fx);
        fx
    }

    /// `resume()`.
    pub fn resume(&mut self) -> Vec<IdleEffect> {
        let mut fx = Vec::new();
        self.suspended = false;
        self.reset(&mut fx);
        fx
    }

    /// `resolve()`.
    pub fn resolve(&mut self) -> Vec<IdleEffect> {
        let mut fx = Vec::new();
        self.reset(&mut fx);
        fx
    }

    fn clear_deadline(&mut self, fx: &mut Vec<IdleEffect>) {
        if self.deadline_timer {
            fx.push(IdleEffect::Clear);
        }
        self.deadline_timer = false;
    }

    fn cancel_warning(&mut self, fx: &mut Vec<IdleEffect>) {
        if self.phase != IdlePhase::Warning {
            return;
        }
        fx.push(IdleEffect::WarningCancelled);
        self.reset(fx);
    }

    fn reset(&mut self, fx: &mut Vec<IdleEffect>) {
        self.clear_deadline(fx);
        self.phase = IdlePhase::None;
        self.idle_started_at = 0.0;
        self.warning_trigger_sec = 0.0;
        self.threshold_sec = 0.0;
        self.deadline_at = 0.0;
    }
}
