//! Port of `legacy/agent/src/main/services/promptReachability.ts`: what a request
//! for the main window means while a prompt is active. A pure decision over
//! durations; the caller owns the clock.

use serde::{Deserialize, Serialize};

/// Port of `PromptGateDecision`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum PromptGateDecision {
    /// No prompt is in the way; open the window.
    #[serde(rename = "show-window")]
    ShowWindow,
    /// A prompt is up and this is the first ask; put it back in front.
    #[serde(rename = "restore-prompt")]
    RestorePrompt,
    /// They asked again straight away; the prompt is unreachable.
    #[serde(rename = "release-and-show")]
    ReleaseAndShow,
}

/// Port of `PromptGateInput`.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptGateInput {
    /// Is a prompt currently active?
    pub has_prompt: bool,
    /// Time since a prompt was last re-presented in response to a request;
    /// `None` when never (the first ask of this run).
    pub since_last_restore_ms: Option<f64>,
    /// How recent a previous restore has to be for this ask to count as a repeat.
    pub window_ms: f64,
}

/// Long enough to cover a slow present, short enough that two deliberate clicks
/// minutes apart are never mistaken for "that did nothing".
pub const PROMPT_UNREACHABLE_WINDOW_MS: f64 = 12_000.0;

/// Port of `decidePromptGate`.
#[must_use]
pub fn decide_prompt_gate(input: &PromptGateInput) -> PromptGateDecision {
    if !input.has_prompt {
        return PromptGateDecision::ShowWindow;
    }
    let Some(since) = input.since_last_restore_ms else {
        return PromptGateDecision::RestorePrompt;
    };
    // A negative reading means the clock moved backwards: a fresh ask.
    if since < 0.0 {
        return PromptGateDecision::RestorePrompt;
    }
    if since < input.window_ms {
        PromptGateDecision::ReleaseAndShow
    } else {
        PromptGateDecision::RestorePrompt
    }
}
