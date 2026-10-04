//! Port of `legacy/agent/src/main/services/idle/decide.ts`.

use crate::js::math::mul;
use crate::js::number::{max, sub};

/// Port of `IdleInputs`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IdleInputs {
    pub is_running: bool,
    /// Seconds since the last input (from the OS).
    pub idle_seconds: f64,
    /// Threshold in seconds before we prompt.
    pub threshold_sec: f64,
    /// A prompt is already showing.
    pub prompting: bool,
}

/// Port of `shouldPromptIdle`. Unused in production (the monitor decides inline);
/// ported because it is exported and tested.
#[must_use]
pub fn should_prompt_idle(i: &IdleInputs) -> bool {
    i.is_running && !i.prompting && i.idle_seconds >= i.threshold_sec
}

/// Port of `computeIdleStart`: the real moment the user went idle, `now` minus
/// the OS idle duration (a negative idle time counts as `0`).
#[must_use]
pub fn compute_idle_start(now_ms: f64, idle_seconds: f64) -> f64 {
    sub(now_ms, mul(max(0.0, idle_seconds), 1000.0))
}
