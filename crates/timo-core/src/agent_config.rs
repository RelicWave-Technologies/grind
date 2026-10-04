//! The agent's runtime capture config and how a server response changes it.
//!
//! Port of the pure logic of `legacy/agent/src/main/services/agentConfig.ts`
//! (SC-76): `snapshot`, `sameConfig`, the clamps in `applyAgentConfig`, and the
//! single-flight and session rules of `refreshAgentConfig`. The fetch, the
//! workspace-time write, the token reads and the listeners stay in the app
//! crate; it calls [`AgentConfigRuntime::apply`] *after* it has applied the
//! workspace timezone and re-checked the session.

use serde::Serialize;

use crate::agent_config_response::{AgentConfigResponse, TodayLedgerMode};
use crate::js::number::{i64_to_f64, max, strict_eq};

/// Port of `RuntimeAgentConfig` (key order as `snapshot()` builds it).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeAgentConfig {
    pub config_version: Option<String>,
    pub screenshot_interval_sec: f64,
    pub idle_threshold_sec: f64,
    pub idle_warning_seconds: Option<i64>,
    pub capture_apps: bool,
    pub capture_titles: bool,
    pub capture_urls: bool,
    pub today_ledger_mode: TodayLedgerMode,
    pub dashboard_url: String,
    pub workspace_timezone: String,
}

/// Port of `AgentConfigChange`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AgentConfigChange {
    pub previous: Option<RuntimeAgentConfig>,
    pub current: RuntimeAgentConfig,
}

/// The boot values from `env.ts`. An explicit `AGENT_SHOT_SEC` / `AGENT_IDLE_SEC`
/// *locks* that value so a server refresh cannot override it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EnvDefaults {
    pub screenshot_interval_sec: f64,
    pub idle_threshold_sec: f64,
    pub shot_locked: bool,
    pub idle_locked: bool,
}

/// The module state of `agentConfig.ts` and `hasAppliedConfig`.
#[derive(Debug, Clone, PartialEq)]
pub struct AgentConfigRuntime {
    env: EnvDefaults,
    current: RuntimeAgentConfig,
    has_applied: bool,
}

/// Port of `sameConfig`: every field `===`, and a `null` previous is never the
/// same (so the first apply always notifies).
#[must_use]
pub fn same_config(a: Option<&RuntimeAgentConfig>, b: &RuntimeAgentConfig) -> bool {
    a.is_some_and(|a| {
        a.config_version == b.config_version
            && strict_eq(a.screenshot_interval_sec, b.screenshot_interval_sec)
            && strict_eq(a.idle_threshold_sec, b.idle_threshold_sec)
            && a.idle_warning_seconds == b.idle_warning_seconds
            && a.capture_apps == b.capture_apps
            && a.capture_titles == b.capture_titles
            && a.capture_urls == b.capture_urls
            && a.today_ledger_mode == b.today_ledger_mode
            && a.dashboard_url == b.dashboard_url
            && a.workspace_timezone == b.workspace_timezone
    })
}

impl AgentConfigRuntime {
    /// Privacy-first boot state: nothing captured, ledger `OFF`, zone `UTC`.
    #[must_use]
    pub fn new(env: EnvDefaults) -> Self {
        Self {
            env,
            current: RuntimeAgentConfig {
                config_version: None,
                screenshot_interval_sec: env.screenshot_interval_sec,
                idle_threshold_sec: env.idle_threshold_sec,
                idle_warning_seconds: None,
                capture_apps: false,
                capture_titles: false,
                capture_urls: false,
                today_ledger_mode: TodayLedgerMode::Off,
                dashboard_url: String::new(),
                workspace_timezone: "UTC".to_owned(),
            },
            has_applied: false,
        }
    }

    /// Port of `snapshot`.
    #[must_use]
    pub const fn snapshot(&self) -> &RuntimeAgentConfig {
        &self.current
    }

    /// The tail of `applyAgentConfig` (everything after the session re-check).
    /// Returns the change to broadcast, or `None` when nothing differs.
    pub fn apply(&mut self, cfg: &AgentConfigResponse) -> Option<AgentConfigChange> {
        let previous = self.has_applied.then(|| self.current.clone());
        let env = self.env;
        let now = &mut self.current;
        now.config_version = Some(cfg.config_version.clone()).filter(|v| !v.is_empty());
        if !env.shot_locked {
            now.screenshot_interval_sec = minutes_to_seconds(cfg.screenshot_interval_min);
        }
        if !env.idle_locked {
            now.idle_threshold_sec = minutes_to_seconds(cfg.idle_threshold_min);
        }
        // The warning only counts when it fires before the idle threshold.
        now.idle_warning_seconds = cfg
            .idle_warning_seconds
            .filter(|warn| i64_to_f64(*warn).is_ok_and(|warn| warn < now.idle_threshold_sec));
        now.dashboard_url.clone_from(&cfg.dashboard_url);
        now.workspace_timezone.clone_from(&cfg.workspace_timezone);
        now.capture_apps = cfg.capture_apps;
        now.capture_titles = cfg.capture_apps && cfg.capture_titles;
        now.capture_urls = cfg.capture_apps && cfg.capture_urls;
        now.today_ledger_mode = cfg.today_ledger_mode;
        self.has_applied = true;
        let current = self.current.clone();
        (!same_config(previous.as_ref(), &current))
            .then_some(AgentConfigChange { previous, current })
    }
}

/// `Math.max(60, minutes * 60)`.
#[allow(
    clippy::float_arithmetic,
    reason = "minutes * 60 is the TypeScript's own arithmetic on small integers"
)]
fn minutes_to_seconds(minutes: i64) -> f64 {
    max(60.0, i64_to_f64(minutes).unwrap_or(f64::NAN) * 60.0)
}

/// `${userId}:${workspaceId}`: the key `refreshAgentConfig` single-flights on.
/// (Two different sessions can collide on it if an id contains a colon; the
/// TypeScript has the same key.)
#[must_use]
pub fn session_key(user_id: &str, workspace_id: &str) -> String {
    format!("{user_id}:{workspace_id}")
}

/// What `refreshAgentConfig` does when another refresh may be running.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefreshPlan {
    /// No refresh in flight: start one.
    Start,
    /// One is in flight for the same session: share its result.
    Join,
    /// One is in flight for another session: wait for it, then plan again.
    WaitThenRetry,
}

/// Port of the branch at the top of `refreshAgentConfig`.
#[must_use]
pub fn refresh_plan(in_flight: Option<&str>, requested_key: &str) -> RefreshPlan {
    match in_flight {
        None => RefreshPlan::Start,
        Some(key) if key == requested_key => RefreshPlan::Join,
        Some(_) => RefreshPlan::WaitThenRetry,
    }
}

/// The session check used twice in the TypeScript (after the fetch, and again
/// inside `applyAgentConfig`): the stored session must still be the requester's
/// user **and** workspace, else the response is discarded.
#[must_use]
pub fn same_session(requested: (&str, &str), current: Option<(&str, &str)>) -> bool {
    current == Some(requested)
}
