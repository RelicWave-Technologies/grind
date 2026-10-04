//! Resume polling of a permission prompt that stood down for System Settings.

use super::TrackingAttentionCoordinator;
use crate::tracking_attention::env::AttentionEnv;
use crate::tracking_attention::types::{AttentionPrompt, PermissionPresentation};

/// One resume check in flight. The caller evaluates the predicate it handed to
/// `yield_permission_to_system_settings` and reports back through
/// `finish_resume_check` (the TypeScript does both in promise continuations).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResumeCheck {
    predicate: u64,
}

impl ResumeCheck {
    /// Which `yield` call's predicate this check belongs to (1-based).
    #[must_use]
    pub fn predicate(self) -> u64 {
        self.predicate
    }
}

/// What the resume predicate said.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeProbe {
    /// It returned `true`.
    Done,
    /// It returned `false`.
    NotYet,
    /// It threw or rejected: swallowed, the next poll tries again.
    Failed,
}

impl<E: AttentionEnv> TrackingAttentionCoordinator<E> {
    pub(super) fn start_resume_polling(&mut self) {
        if self.resume_timer || self.resume_when.is_none() {
            return;
        }
        self.resume_timer = true;
        self.env.set_interval(self.resume_poll_ms);
    }

    pub(super) fn stop_resume_polling(&mut self) {
        self.resume_when = None;
        if !self.resume_timer {
            return;
        }
        self.env.clear_interval();
        self.resume_timer = false;
    }

    /// `checkResume`: one poll of the resume predicate. Returns the check the
    /// caller must evaluate and report, or `None` when there is nothing to do.
    pub fn begin_resume_check(&mut self) -> Option<ResumeCheck> {
        let predicate = self.resume_when?;
        if self.resume_check_in_flight {
            return None;
        }
        self.resume_check_in_flight = true;
        Some(ResumeCheck { predicate })
    }

    /// The promise chain of `checkResume` settled.
    pub fn finish_resume_check(&mut self, check: ResumeCheck, probe: ResumeProbe) {
        if probe == ResumeProbe::Done && self.resume_when == Some(check.predicate) {
            self.restore_active();
        }
        self.resume_check_in_flight = false;
    }

    /// `yieldPermissionToSystemSettings`: stand down for System Settings and
    /// come back by itself once the predicate (when `has_resume_when`) says so.
    pub fn yield_permission_to_system_settings(
        &mut self,
        prompt_id: &str,
        has_resume_when: bool,
    ) -> bool {
        let AttentionPrompt::Permission {
            prompt_id: current,
            intent,
            ..
        } = &self.active
        else {
            return false;
        };
        if current != prompt_id {
            return false;
        }
        self.active = AttentionPrompt::Permission {
            prompt_id: current.clone(),
            intent: *intent,
            presentation: PermissionPresentation::YieldedToSettings,
        };
        self.stop_resume_polling();
        if has_resume_when {
            self.yields += 1;
            self.resume_when = Some(self.yields);
        }
        self.env.publish(&self.active);
        self.env.lower();
        self.start_resume_polling();
        true
    }
}
