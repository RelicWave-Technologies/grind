//! The injected world of the coordinator: the overlay host
//! (`attentionWindow.ts::OverlayHost`), the id generator, the resume-poll
//! interval and the optional logger.

use serde::Serialize;

use super::types::AttentionPrompt;

/// `'topRight' | 'center'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Placement {
    TopRight,
    Center,
}

/// Port of `PlacementSpec`: `{ width, height, placement }`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct PlacementSpec {
    pub width: f64,
    pub height: f64,
    pub placement: Placement,
}

/// `info` or `warn` of the optional `TrackingAttentionLogger`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LogLevel {
    Info,
    Warn,
}

/// The `meta` argument of each log call, field order as in the TypeScript.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged, rename_all_fields = "camelCase")]
pub enum AttentionLog {
    Shown {
        kind: &'static str,
        prompt_id: String,
        previous: &'static str,
        floating: bool,
    },
    Restored {
        kind: &'static str,
        prompt_id: String,
        floating: bool,
    },
    Released {
        kind: &'static str,
        prompt_id: String,
        reason: String,
        floating_when_released: bool,
    },
    Cleared {
        kind: &'static str,
        prompt_id: String,
    },
}

/// One log call: level, message and meta.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LogEntry {
    pub level: LogLevel,
    pub message: &'static str,
    pub meta: AttentionLog,
}

/// Everything the coordinator reaches outside itself for. Every method is a
/// call the TypeScript makes on `deps` or `deps.host`, in the same order.
pub trait AttentionEnv {
    /// `deps.id()`.
    fn next_id(&mut self) -> String;
    /// `host.place(spec)`.
    fn place(&mut self, spec: &PlacementSpec);
    /// `host.keep()`.
    fn keep(&mut self);
    /// `host.release()`.
    fn release(&mut self);
    /// `host.activate()`.
    fn activate(&mut self);
    /// `host.onTop()`; `None` when it throws (the coordinator then believes
    /// `false`).
    fn on_top(&mut self) -> Option<bool>;
    /// `host.lower()`.
    fn lower(&mut self);
    /// `host.hide()`.
    fn hide(&mut self);
    /// `host.publish(prompt)`.
    fn publish(&mut self, prompt: &AttentionPrompt);
    /// `host.onReady(listener)`: registers the coordinator's listener; the
    /// owner later calls `TrackingAttentionCoordinator::overlay_ready`.
    fn on_ready(&mut self);
    /// `setInterval(checkResume, ms)` (the timer is `unref`'d).
    fn set_interval(&mut self, ms: f64);
    /// `clearInterval(timer)`.
    fn clear_interval(&mut self);
    /// Whether a logger was injected. The TypeScript uses `log?.info(...)`, so
    /// without one the meta (including `floatBelief()`) is never evaluated.
    fn logging(&self) -> bool;
    /// `log.info(...)` / `log.warn(...)`.
    fn log(&mut self, entry: &LogEntry);
}
