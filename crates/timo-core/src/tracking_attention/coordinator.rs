//! Port of `createTrackingAttentionCoordinator` in
//! `legacy/agent/src/main/services/trackingAttention.ts`.

mod resume;

pub use resume::{ResumeCheck, ResumeProbe};

use super::env::{AttentionEnv, AttentionLog, LogEntry, LogLevel, Placement, PlacementSpec};
use super::types::{
    AttentionPrompt, AwayInfo, IdleWarningInfo, PermissionIntent, PermissionPresentation,
};

/// `RESUME_POLL_MS`: polling for "has the permission been granted yet" hits a
/// real capability probe, so it is slower than the keeper's cadence.
pub const RESUME_POLL_MS: f64 = 2_000.0;

/// `SIZES[prompt.kind]` and the placement of `specFor`.
fn spec_for(prompt: &AttentionPrompt) -> Option<PlacementSpec> {
    let (width, height) = match prompt {
        AttentionPrompt::None => return None,
        AttentionPrompt::IdleWarning { .. } | AttentionPrompt::Idle { .. } => (340.0, 280.0),
        AttentionPrompt::Away { .. } => (360.0, 222.0),
        AttentionPrompt::Permission { .. } => (480.0, 332.0),
    };
    let placement = if matches!(prompt, AttentionPrompt::Away { .. }) {
        Placement::TopRight
    } else {
        Placement::Center
    };
    Some(PlacementSpec {
        width,
        height,
        placement,
    })
}

/// `isFront`: a prompt that should currently sit on top of everything.
fn is_front(prompt: &AttentionPrompt) -> bool {
    match prompt {
        AttentionPrompt::None => false,
        AttentionPrompt::Permission { presentation, .. } => {
            *presentation == PermissionPresentation::Front
        }
        _ => true,
    }
}

/// Port of the coordinator closure.
#[derive(Debug)]
pub struct TrackingAttentionCoordinator<E: AttentionEnv> {
    env: E,
    resume_poll_ms: f64,
    active: AttentionPrompt,
    resume_timer: bool,
    /// `resumeWhen !== null`, as the id of the `yield` that set it.
    resume_when: Option<u64>,
    yields: u64,
    resume_check_in_flight: bool,
    ready_hooked: bool,
}

impl<E: AttentionEnv> TrackingAttentionCoordinator<E> {
    /// `createTrackingAttentionCoordinator(deps)`; `resume_poll_ms` defaults to
    /// [`RESUME_POLL_MS`].
    pub fn new(env: E, resume_poll_ms: Option<f64>) -> Self {
        Self {
            env,
            resume_poll_ms: resume_poll_ms.unwrap_or(RESUME_POLL_MS),
            active: AttentionPrompt::None,
            resume_timer: false,
            resume_when: None,
            yields: 0,
            resume_check_in_flight: false,
            ready_hooked: false,
        }
    }

    pub fn env(&self) -> &E {
        &self.env
    }

    pub fn env_mut(&mut self) -> &mut E {
        &mut self.env
    }

    /// `get()`.
    pub fn get(&self) -> &AttentionPrompt {
        &self.active
    }

    /// `isPermissionActive()`.
    pub fn is_permission_active(&self) -> bool {
        matches!(self.active, AttentionPrompt::Permission { .. })
    }

    /// `floatBelief()`: what the app believes about the overlay, `false` if the
    /// host throws.
    fn float_belief(&mut self) -> bool {
        self.env.on_top().unwrap_or(false)
    }

    fn log(&mut self, level: LogLevel, message: &'static str, meta: AttentionLog) {
        self.env.log(&LogEntry {
            level,
            message,
            meta,
        });
    }

    /// The `host.onReady` listener: the renderer finished loading, so the
    /// surface has to be re-presented or it shows empty.
    pub fn overlay_ready(&mut self) {
        if matches!(self.active, AttentionPrompt::None) {
            return;
        }
        self.env.publish(&self.active);
        if is_front(&self.active) {
            self.present_now();
        }
    }

    fn hook_ready_once(&mut self) {
        if self.ready_hooked {
            return;
        }
        self.ready_hooked = true;
        self.env.on_ready();
    }

    /// Place once, activate once, then hand it to the keeper.
    fn present_now(&mut self) {
        if !is_front(&self.active) {
            return;
        }
        if let Some(spec) = spec_for(&self.active) {
            self.env.place(&spec);
        }
        self.env.activate();
        self.env.keep();
    }

    fn stop_holding(&mut self) {
        self.env.release();
        self.stop_resume_polling();
    }

    fn show(&mut self, next: AttentionPrompt) {
        let previous = self.active.kind();
        self.active = next;
        self.stop_resume_polling();
        self.hook_ready_once();
        self.env.publish(&self.active);
        self.present_now();
        if self.env.logging() {
            let floating = self.float_belief();
            let meta = AttentionLog::Shown {
                kind: self.active.kind(),
                prompt_id: self.active.prompt_id().unwrap_or_default().to_owned(),
                previous,
                floating,
            };
            self.log(LogLevel::Info, "attention prompt shown", meta);
        }
    }

    /// `requestIdle`.
    pub fn request_idle(&mut self, idle_started_at: f64) -> bool {
        if let AttentionPrompt::IdleWarning { prompt_id, .. } = &self.active {
            let prompt_id = prompt_id.clone();
            self.show(AttentionPrompt::Idle {
                prompt_id,
                idle_started_at,
            });
            return true;
        }
        if !matches!(self.active, AttentionPrompt::None) {
            return false;
        }
        let prompt_id = self.env.next_id();
        self.show(AttentionPrompt::Idle {
            prompt_id,
            idle_started_at,
        });
        true
    }

    /// `requestIdleWarning`.
    pub fn request_idle_warning(&mut self, info: IdleWarningInfo) -> bool {
        if !matches!(self.active, AttentionPrompt::None) {
            return false;
        }
        let prompt_id = self.env.next_id();
        self.show(AttentionPrompt::IdleWarning {
            prompt_id,
            idle_started_at: info.idle_started_at,
            deadline_at: info.deadline_at,
        });
        true
    }

    /// `clearIdleWarning`.
    pub fn clear_idle_warning(&mut self) -> bool {
        match &self.active {
            AttentionPrompt::IdleWarning { prompt_id, .. } => {
                let id = prompt_id.clone();
                self.clear(Some(&id))
            }
            _ => false,
        }
    }

    /// `beginMachineAway`.
    pub fn begin_machine_away(&mut self) {
        if matches!(
            self.active,
            AttentionPrompt::IdleWarning { .. }
                | AttentionPrompt::Idle { .. }
                | AttentionPrompt::Away { .. }
        ) {
            self.active = AttentionPrompt::None;
            self.stop_holding();
            self.env.hide();
        }
    }

    /// `requestAway`.
    pub fn request_away(&mut self, info: AwayInfo) -> bool {
        if matches!(self.active, AttentionPrompt::Permission { .. }) {
            return false;
        }
        let prompt_id = self.env.next_id();
        self.show(AttentionPrompt::Away {
            prompt_id,
            lark_task_guid: info.lark_task_guid,
            stopped_at: info.stopped_at,
            reason: info.reason,
        });
        true
    }

    /// `requestPermission`: keeps one identity while the intent changes.
    pub fn request_permission(&mut self, intent: PermissionIntent) -> AttentionPrompt {
        let prompt_id = match &self.active {
            AttentionPrompt::Permission { prompt_id, .. } => prompt_id.clone(),
            _ => self.env.next_id(),
        };
        self.show(AttentionPrompt::Permission {
            prompt_id,
            intent,
            presentation: PermissionPresentation::Front,
        });
        self.active.clone()
    }

    /// `restoreActive`: put the active prompt back in front.
    pub fn restore_active(&mut self) -> bool {
        if matches!(self.active, AttentionPrompt::None) {
            return false;
        }
        self.stop_resume_polling();
        if let AttentionPrompt::Permission {
            prompt_id,
            intent,
            presentation: PermissionPresentation::YieldedToSettings,
        } = &self.active
        {
            self.active = AttentionPrompt::Permission {
                prompt_id: prompt_id.clone(),
                intent: *intent,
                presentation: PermissionPresentation::Front,
            };
            self.env.publish(&self.active);
        }
        self.present_now();
        if self.env.logging() {
            let floating = self.float_belief();
            let meta = AttentionLog::Restored {
                kind: self.active.kind(),
                prompt_id: self.active.prompt_id().unwrap_or_default().to_owned(),
                floating,
            };
            self.log(LogLevel::Info, "attention prompt restored", meta);
        }
        true
    }

    /// `releaseUnreachable`: give up on a prompt the person cannot reach.
    pub fn release_unreachable(&mut self, reason: &str) -> bool {
        if matches!(self.active, AttentionPrompt::None) {
            return false;
        }
        let released = self.active.kind();
        let prompt_id = self.active.prompt_id().unwrap_or_default().to_owned();
        self.stop_resume_polling();
        self.stop_holding();
        self.active = AttentionPrompt::None;
        self.env.publish(&self.active);
        self.env.hide();
        if self.env.logging() {
            let floating_when_released = self.float_belief();
            let meta = AttentionLog::Released {
                kind: released,
                prompt_id,
                reason: reason.to_owned(),
                floating_when_released,
            };
            self.log(
                LogLevel::Warn,
                "attention prompt released as unreachable",
                meta,
            );
        }
        true
    }

    /// `clear(promptId?)`.
    pub fn clear(&mut self, prompt_id: Option<&str>) -> bool {
        if matches!(self.active, AttentionPrompt::None) {
            return false;
        }
        // `promptId &&` : an empty string behaves as "no id given".
        if let Some(id) = prompt_id.filter(|s| !s.is_empty())
            && self.active.prompt_id() != Some(id)
        {
            return false;
        }
        let cleared = self.active.kind();
        let cleared_id = self.active.prompt_id().unwrap_or_default().to_owned();
        self.active = AttentionPrompt::None;
        self.stop_holding();
        self.env.publish(&self.active);
        self.env.hide();
        if self.env.logging() {
            let meta = AttentionLog::Cleared {
                kind: cleared,
                prompt_id: cleared_id,
            };
            self.log(LogLevel::Info, "attention prompt cleared", meta);
        }
        true
    }
}
