//! Port of `legacy/agent/src/shared/attention.ts` (the prompt union).

use serde::{Deserialize, Serialize};

/// Port of `PermissionIntent`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PermissionIntent {
    #[serde(rename = "START_TASK")]
    StartTask,
    #[serde(rename = "RESUME_ENTRY")]
    ResumeEntry,
    #[serde(rename = "SETUP")]
    Setup,
}

/// `'FRONT' | 'YIELDED_TO_SETTINGS'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PermissionPresentation {
    #[serde(rename = "FRONT")]
    Front,
    #[serde(rename = "YIELDED_TO_SETTINGS")]
    YieldedToSettings,
}

/// `'suspend' | 'lock'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AwayReason {
    Suspend,
    Lock,
}

/// Port of `AttentionPrompt`. Field order is the TypeScript object literals'.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum AttentionPrompt {
    #[serde(rename = "NONE")]
    None,
    #[serde(rename = "IDLE_WARNING")]
    IdleWarning {
        prompt_id: String,
        idle_started_at: f64,
        deadline_at: f64,
    },
    #[serde(rename = "IDLE")]
    Idle {
        prompt_id: String,
        idle_started_at: f64,
    },
    #[serde(rename = "AWAY")]
    Away {
        prompt_id: String,
        lark_task_guid: Option<String>,
        stopped_at: f64,
        reason: AwayReason,
    },
    #[serde(rename = "PERMISSION")]
    Permission {
        prompt_id: String,
        intent: PermissionIntent,
        presentation: PermissionPresentation,
    },
}

impl AttentionPrompt {
    /// `prompt.kind`.
    #[must_use]
    pub fn kind(&self) -> &'static str {
        match self {
            Self::None => "NONE",
            Self::IdleWarning { .. } => "IDLE_WARNING",
            Self::Idle { .. } => "IDLE",
            Self::Away { .. } => "AWAY",
            Self::Permission { .. } => "PERMISSION",
        }
    }

    /// `prompt.promptId` (`None` for `NONE`).
    #[must_use]
    pub fn prompt_id(&self) -> Option<&str> {
        match self {
            Self::None => None,
            Self::IdleWarning { prompt_id, .. }
            | Self::Idle { prompt_id, .. }
            | Self::Away { prompt_id, .. }
            | Self::Permission { prompt_id, .. } => Some(prompt_id),
        }
    }
}

/// The `{ idleStartedAt, deadlineAt }` argument of `requestIdleWarning`.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleWarningInfo {
    pub idle_started_at: f64,
    pub deadline_at: f64,
}

/// The `{ larkTaskGuid, stoppedAt, reason }` argument of `requestAway`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwayInfo {
    pub lark_task_guid: Option<String>,
    pub stopped_at: f64,
    pub reason: AwayReason,
}
