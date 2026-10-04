//! The single owner of "which prompt is the user being asked to answer".
//!
//! Port of `legacy/agent/src/main/services/trackingAttention.ts` and the prompt
//! types of `legacy/agent/src/shared/attention.ts`.

pub mod coordinator;
pub mod env;
pub mod types;

pub use coordinator::{ResumeCheck, ResumeProbe, TrackingAttentionCoordinator};
pub use env::{AttentionEnv, AttentionLog, LogEntry, LogLevel, Placement, PlacementSpec};
pub use types::{
    AttentionPrompt, AwayInfo, AwayReason, IdleWarningInfo, PermissionIntent,
    PermissionPresentation,
};
