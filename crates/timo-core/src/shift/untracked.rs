//! Pure state machine for the "Are you working?" nudge.
//!
//! Port of `legacy/agent/src/main/services/shift/untracked.ts`. The user is at
//! the machine, inside their shift, and no timer runs: the shape of forgetting
//! to press start. Three rules keep it from being annoying: only time the user
//! was actually there counts (the streak is driven by OS idle time), only
//! inside the shift, and it never stacks on another prompt.

use serde::{Deserialize, Serialize};

use crate::js::number::{add, sub};

/// Active-but-untracked time needed before the first nudge.
pub const ACTIVE_STREAK_MS: f64 = 600_000.0;
/// How long "Not now" buys.
pub const SNOOZE_MS: f64 = 1_800_000.0;
/// OS idle time that counts as "not at the machine".
pub const AWAY_RESET_SEC: f64 = 60.0;

/// Port of `UntrackedNudgeState` (key order as in the TypeScript object).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UntrackedNudgeState {
    /// Epoch ms when the current active-and-untracked streak began.
    pub active_since: Option<f64>,
    /// Epoch ms before which we stay quiet, set by "Not now".
    pub snoozed_until: Option<f64>,
    /// The toast is on screen.
    pub prompting: bool,
}

/// Port of `UNTRACKED_INITIAL_STATE`.
pub const UNTRACKED_INITIAL_STATE: UntrackedNudgeState = UntrackedNudgeState {
    active_since: None,
    snoozed_until: None,
    prompting: false,
};

/// Port of `UntrackedAction`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum UntrackedAction {
    Show,
    Hide,
    Noop,
}

/// Port of `UntrackedTickInput`.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UntrackedTickInput {
    pub state: UntrackedNudgeState,
    /// Epoch ms.
    pub now: f64,
    /// Inside the user's assigned shift window.
    pub in_shift: bool,
    /// A timer is currently running.
    pub tracking: bool,
    /// `powerMonitor.getSystemIdleTime()`.
    pub idle_seconds: f64,
    /// An idle / away / permission prompt already owns the screen.
    pub attention_busy: bool,
}

/// Port of `UntrackedTickResult`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct UntrackedTickResult {
    pub state: UntrackedNudgeState,
    pub action: UntrackedAction,
}

fn hide_if(prompting: bool) -> UntrackedAction {
    if prompting {
        UntrackedAction::Hide
    } else {
        UntrackedAction::Noop
    }
}

/// Port of `stand`: drop the toast if it is up, and forget the streak.
fn stand(state: &UntrackedNudgeState) -> UntrackedTickResult {
    UntrackedTickResult {
        state: UntrackedNudgeState {
            active_since: None,
            prompting: false,
            ..*state
        },
        action: hide_if(state.prompting),
    }
}

/// Port of `tickUntrackedNudge`.
#[must_use]
pub fn tick_untracked_nudge(input: &UntrackedTickInput) -> UntrackedTickResult {
    let (state, now) = (&input.state, input.now);
    // Tracking, off-shift, or away: nothing to nudge about.
    if input.tracking || !input.in_shift || input.idle_seconds >= AWAY_RESET_SEC {
        return stand(state);
    }
    // Something more urgent owns the screen: yield. `activeSince` is left as it
    // is (the comment in the TypeScript says the streak "lapses", the code does
    // not clear it, so a non-idle prompt banks the streak): copied, not fixed.
    if input.attention_busy {
        return UntrackedTickResult {
            state: UntrackedNudgeState {
                prompting: false,
                ..*state
            },
            action: hide_if(state.prompting),
        };
    }
    let active_since = state.active_since.unwrap_or(now);
    let next = UntrackedNudgeState {
        active_since: Some(active_since),
        ..*state
    };
    let quiet = |state| UntrackedTickResult {
        state,
        action: UntrackedAction::Noop,
    };
    if state.snoozed_until.is_some_and(|until| now < until) {
        return quiet(next);
    }
    if state.prompting || sub(now, active_since) < ACTIVE_STREAK_MS {
        return quiet(next);
    }
    UntrackedTickResult {
        state: UntrackedNudgeState {
            prompting: true,
            snoozed_until: None,
            ..next
        },
        action: UntrackedAction::Show,
    }
}

/// Port of `acceptUntrackedNudge`: "Yes" starts tracking, so the streak is over.
#[must_use]
pub const fn accept_untracked_nudge(_state: &UntrackedNudgeState) -> UntrackedNudgeState {
    UntrackedNudgeState {
        active_since: None,
        snoozed_until: None,
        prompting: false,
    }
}

/// Port of `snoozeUntrackedNudge`: "Not now" (default 30 minutes).
#[must_use]
pub fn snooze_untracked_nudge(
    state: &UntrackedNudgeState,
    now: f64,
    snooze_ms: Option<f64>,
) -> UntrackedNudgeState {
    UntrackedNudgeState {
        snoozed_until: Some(add(now, snooze_ms.unwrap_or(SNOOZE_MS))),
        prompting: false,
        ..*state
    }
}
