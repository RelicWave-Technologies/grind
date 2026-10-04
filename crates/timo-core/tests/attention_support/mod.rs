//! A recording `AttentionEnv` shared by the ported coordinator tests and the
//! golden-fixture replay. It mirrors the fake `OverlayHost` of
//! `trackingAttention.test.ts`: `keep` and `activate` put the overlay on top,
//! `lower` takes it off, and every call is recorded in order.
#![allow(
    dead_code,
    clippy::struct_excessive_bools,
    reason = "each test crate uses a subset; the fake host mirrors the test file's four independent flags"
)]

use serde::Serialize;
use timo_core::tracking_attention::{
    AttentionEnv, AttentionPrompt, LogEntry, PlacementSpec, TrackingAttentionCoordinator,
};

/// One call into the outside world.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "e", rename_all = "camelCase")]
pub enum Call {
    Id { value: String },
    Place { spec: PlacementSpec },
    Keep,
    Release,
    Activate,
    OnTop { value: Option<bool> },
    Lower,
    Hide,
    Publish { prompt: AttentionPrompt },
    OnReady,
    SetInterval { ms: f64 },
    ClearInterval,
    Log { entry: LogEntry },
}

#[derive(Debug)]
pub struct FakeEnv {
    pub calls: Vec<Call>,
    pub on_top: bool,
    pub throw_on_top: bool,
    pub ready_registered: bool,
    pub logging: bool,
    next: u32,
}

impl FakeEnv {
    pub fn new(logging: bool) -> Self {
        Self {
            calls: Vec::new(),
            on_top: true,
            throw_on_top: false,
            ready_registered: false,
            logging,
            next: 0,
        }
    }

    pub fn count(&self, pred: impl Fn(&Call) -> bool) -> usize {
        self.calls.iter().filter(|c| pred(c)).count()
    }

    pub fn clear_calls(&mut self) {
        self.calls.clear();
    }

    pub fn logs(&self) -> Vec<&LogEntry> {
        self.calls
            .iter()
            .filter_map(|c| match c {
                Call::Log { entry } => Some(entry),
                _ => None,
            })
            .collect()
    }
}

impl AttentionEnv for FakeEnv {
    fn next_id(&mut self) -> String {
        self.next += 1;
        let value = format!("prompt-{}", self.next);
        self.calls.push(Call::Id {
            value: value.clone(),
        });
        value
    }
    fn place(&mut self, spec: &PlacementSpec) {
        self.calls.push(Call::Place { spec: *spec });
    }
    fn keep(&mut self) {
        self.on_top = true;
        self.calls.push(Call::Keep);
    }
    fn release(&mut self) {
        self.calls.push(Call::Release);
    }
    fn activate(&mut self) {
        self.on_top = true;
        self.calls.push(Call::Activate);
    }
    fn on_top(&mut self) -> Option<bool> {
        let value = if self.throw_on_top {
            None
        } else {
            Some(self.on_top)
        };
        self.calls.push(Call::OnTop { value });
        value
    }
    fn lower(&mut self) {
        self.on_top = false;
        self.calls.push(Call::Lower);
    }
    fn hide(&mut self) {
        self.calls.push(Call::Hide);
    }
    fn publish(&mut self, prompt: &AttentionPrompt) {
        self.calls.push(Call::Publish {
            prompt: prompt.clone(),
        });
    }
    fn on_ready(&mut self) {
        self.ready_registered = true;
        self.calls.push(Call::OnReady);
    }
    fn set_interval(&mut self, ms: f64) {
        self.calls.push(Call::SetInterval { ms });
    }
    fn clear_interval(&mut self) {
        self.calls.push(Call::ClearInterval);
    }
    fn logging(&self) -> bool {
        self.logging
    }
    fn log(&mut self, entry: &LogEntry) {
        self.calls.push(Call::Log {
            entry: entry.clone(),
        });
    }
}

/// How a resume predicate behaves when it is finally evaluated.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Predicate {
    /// `() => granted`.
    Flag,
    /// `() => false`.
    Never,
    /// `() => true`.
    Always,
    /// `() => { throw new Error('probe failed') }`.
    Throws,
}

/// The coordinator plus the bookkeeping the promise chain of `checkResume`
/// gives the TypeScript for free: which predicate each `yield` installed, and
/// the check waiting for its microtask turn.
#[derive(Debug)]
pub struct Rig {
    pub coordinator: TrackingAttentionCoordinator<FakeEnv>,
    pub granted: bool,
    pub predicate_calls: u32,
    predicates: Vec<Predicate>,
    pending: Option<timo_core::tracking_attention::ResumeCheck>,
}

impl Rig {
    pub fn new(logging: bool) -> Self {
        Self::with_poll(logging, None)
    }

    pub fn with_poll(logging: bool, resume_poll_ms: Option<f64>) -> Self {
        Self {
            coordinator: TrackingAttentionCoordinator::new(FakeEnv::new(logging), resume_poll_ms),
            granted: false,
            predicate_calls: 0,
            predicates: Vec::new(),
            pending: None,
        }
    }

    pub fn env(&self) -> &FakeEnv {
        self.coordinator.env()
    }

    /// `yieldPermissionToSystemSettings(promptId, { resumeWhen })`.
    pub fn yield_to_settings(&mut self, prompt_id: &str, resume: Option<Predicate>) -> bool {
        let ok = self
            .coordinator
            .yield_permission_to_system_settings(prompt_id, resume.is_some());
        if ok && let Some(p) = resume {
            self.predicates.push(p);
        }
        ok
    }

    /// `__resumeTickForTests()`.
    pub fn tick(&mut self) {
        if let Some(check) = self.coordinator.begin_resume_check() {
            self.pending = Some(check);
        }
    }

    /// `await flush()`: the pending check's predicate runs and the chain settles.
    pub fn flush(&mut self) {
        use timo_core::tracking_attention::ResumeProbe;
        let Some(check) = self.pending.take() else {
            return;
        };
        let index = usize::try_from(check.predicate().saturating_sub(1)).unwrap_or(usize::MAX);
        let predicate = self
            .predicates
            .get(index)
            .copied()
            .unwrap_or(Predicate::Never);
        self.predicate_calls += 1;
        let probe = match predicate {
            Predicate::Flag if self.granted => ResumeProbe::Done,
            Predicate::Always => ResumeProbe::Done,
            Predicate::Throws => ResumeProbe::Failed,
            Predicate::Flag | Predicate::Never => ResumeProbe::NotYet,
        };
        self.coordinator.finish_resume_check(check, probe);
    }

    /// The `fireReady()` of the test: the registered listener, if any.
    pub fn fire_ready(&mut self) {
        if self.coordinator.env().ready_registered {
            self.coordinator.overlay_ready();
        }
    }
}
