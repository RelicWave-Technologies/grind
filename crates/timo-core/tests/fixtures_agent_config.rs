//! Golden fixtures for the agent's runtime config (SC-76), dumped from the real
//! TypeScript by `parity/` (`src/gen/agentConfig.ts`): the zod schema, and the
//! real `services/agentConfig.ts` refreshed over a sequence of server responses.
#![cfg(test)]

mod common;

use common::run;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use timo_core::agent_config::{
    AgentConfigChange, AgentConfigRuntime, EnvDefaults, RuntimeAgentConfig,
};
use timo_core::agent_config_response::{TodayLedgerMode, parse_agent_config_response};
use timo_core::js::ser::to_string;

fn json<T: Serialize>(value: &T) -> Result<String, String> {
    to_string(value).map_err(|e| e.to_string())
}

#[derive(Deserialize)]
struct ResponseIn {
    raw: Value,
}

#[test]
fn fixture_agent_config_response() {
    run(
        "agentConfig",
        "agent_config_response",
        "agentConfigResponse",
        |i: ResponseIn| {
            parse_agent_config_response(&i.raw).map_or_else(
                || Ok("{\"ok\":false}".to_owned()),
                |data| json(&data).map(|d| format!("{{\"ok\":true,\"data\":{d}}}")),
            )
        },
    );
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnvIn {
    screenshot_interval_sec: f64,
    idle_threshold_sec: f64,
    shot_locked: bool,
    idle_locked: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StepIn {
    #[serde(default)]
    fetch_error: bool,
    #[serde(default)]
    response: Value,
}

#[derive(Deserialize)]
struct RefreshIn {
    env: EnvIn,
    steps: Vec<StepIn>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Capture {
    #[serde(rename = "captureApps")]
    apps: bool,
    #[serde(rename = "captureTitles")]
    titles: bool,
    #[serde(rename = "captureUrls")]
    urls: bool,
}

/// What the getters of `agentConfig.ts` report after each refresh.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct State {
    config_version: Option<String>,
    screenshot_interval_sec: f64,
    idle_threshold_sec: f64,
    idle_warning_seconds: Option<i64>,
    capture: Capture,
    today_ledger_mode: TodayLedgerMode,
    dashboard_url: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StepOut {
    time_zone_applied: Option<(String, String)>,
    change: Option<AgentConfigChange>,
    state: State,
}

fn state_of(c: &RuntimeAgentConfig) -> State {
    State {
        config_version: c.config_version.clone(),
        screenshot_interval_sec: c.screenshot_interval_sec,
        idle_threshold_sec: c.idle_threshold_sec,
        idle_warning_seconds: c.idle_warning_seconds,
        capture: Capture {
            apps: c.capture_apps,
            titles: c.capture_titles,
            urls: c.capture_urls,
        },
        today_ledger_mode: c.today_ledger_mode,
        dashboard_url: c.dashboard_url.clone(),
    }
}

/// `refreshAgentConfig` for one session: fetch (maybe fails), validate, apply
/// the workspace timezone, then apply the rest. The parts that are I/O in the
/// TypeScript are the test's stand-ins, exactly as in `parity/src/tzStubs`.
fn refresh(i: &RefreshIn) -> Result<String, String> {
    let mut runtime = AgentConfigRuntime::new(EnvDefaults {
        screenshot_interval_sec: i.env.screenshot_interval_sec,
        idle_threshold_sec: i.env.idle_threshold_sec,
        shot_locked: i.env.shot_locked,
        idle_locked: i.env.idle_locked,
    });
    let mut out = Vec::new();
    for step in &i.steps {
        let mut applied = None;
        let mut change = None;
        if !step.fetch_error
            && let Some(cfg) = parse_agent_config_response(&step.response)
        {
            applied = Some((cfg.workspace_timezone.clone(), "workspace_1".to_owned()));
            change = runtime.apply(&cfg);
        }
        out.push(json(&StepOut {
            time_zone_applied: applied,
            change,
            state: state_of(runtime.snapshot()),
        })?);
    }
    Ok(format!("[{}]", out.join(",")))
}

#[test]
fn fixture_agent_config_refresh() {
    run(
        "agentConfig",
        "agent_config_refresh",
        "agentConfigRefresh",
        |i: RefreshIn| refresh(&i),
    );
}
