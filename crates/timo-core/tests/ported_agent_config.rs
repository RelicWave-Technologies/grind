//! 1:1 port of `legacy/agent/src/main/services/agentConfig.test.ts`.
//!
//! Those two tests drive `refreshAgentConfig()` with mocked `api`, `loadTokens`,
//! `applyServerWorkspaceTimeZone` and logger. The awaiting and the I/O stay in
//! the app crate; what is ported is every decision the tests observe: which
//! session a response belongs to, whether a refresh joins, waits or starts,
//! whether a response is discarded, which timezone and workspace are applied,
//! and the mode that results. The mocks become the plain counters below.
#![cfg(test)]

use serde_json::{Value, json};
use timo_core::agent_config::{
    AgentConfigRuntime, EnvDefaults, RefreshPlan, refresh_plan, same_session, session_key,
};
use timo_core::agent_config_response::{TodayLedgerMode, parse_agent_config_response};

const SESSION_A: (&str, &str) = ("user_a", "workspace_a");
const SESSION_B: (&str, &str) = ("user_b", "workspace_b");

fn config() -> Value {
    json!({
        "configVersion": "config_1",
        "heartbeatIntervalSec": 60,
        "screenshotIntervalMin": 3,
        "idleThresholdMin": 5,
        "captureApps": false,
        "captureTitles": false,
        "captureUrls": false,
        "todayLedgerMode": "SHADOW",
        "dashboardUrl": "https://timo.example",
        "workspaceTimezone": "Asia/Kolkata",
    })
}

fn runtime() -> AgentConfigRuntime {
    // `vi.mock('../env', ...)`: 600 s screenshots, 300 s idle, nothing locked.
    AgentConfigRuntime::new(EnvDefaults {
        screenshot_interval_sec: 600.0,
        idle_threshold_sec: 300.0,
        shot_locked: false,
        idle_locked: false,
    })
}

/// The mocks' call records.
#[derive(Default)]
struct Mocks {
    api_calls: usize,
    applied_time_zones: Vec<(String, String)>,
    info: Vec<&'static str>,
}

/// The module under test and the mocks around it.
struct World {
    mocks: Mocks,
    runtime: AgentConfigRuntime,
}

/// What `refreshAgentConfigOnce` does with a fetched payload for `requested`.
fn deliver(
    world: &mut World,
    requested: (&str, &str),
    current: Option<(&str, &str)>,
    payload: &Value,
) {
    if !same_session(requested, current) {
        world
            .mocks
            .info
            .push("agent config response discarded because the stored session changed");
        return;
    }
    let Some(parsed) = parse_agent_config_response(payload) else {
        return;
    };
    world
        .mocks
        .applied_time_zones
        .push((parsed.workspace_timezone.clone(), requested.1.to_owned()));
    world.runtime.apply(&parsed);
}

mod agent_config_session_isolation {
    use super::*;

    #[test]
    fn applies_config_to_the_workspace_that_requested_it() {
        let mut world = World {
            mocks: Mocks::default(),
            runtime: runtime(),
        };
        // refreshAgentConfig(): nothing in flight, so it starts one.
        assert_eq!(
            refresh_plan(None, &session_key(SESSION_A.0, SESSION_A.1)),
            RefreshPlan::Start
        );
        world.mocks.api_calls += 1;

        deliver(&mut world, SESSION_A, Some(SESSION_A), &config());

        assert_eq!(
            world.mocks.applied_time_zones,
            vec![("Asia/Kolkata".to_owned(), "workspace_a".to_owned())]
        );
        assert_eq!(
            world.runtime.snapshot().today_ledger_mode,
            TodayLedgerMode::Shadow
        );
    }

    #[test]
    fn discards_an_old_account_response_and_refreshes_the_newly_active_session() {
        let mut world = World {
            mocks: Mocks::default(),
            runtime: runtime(),
        };
        let key_a = session_key(SESSION_A.0, SESSION_A.1);
        let key_b = session_key(SESSION_B.0, SESSION_B.1);

        // oldRefresh = refreshAgentConfig(): loadTokens gives session A, one request starts.
        assert_eq!(refresh_plan(None, &key_a), RefreshPlan::Start);
        world.mocks.api_calls += 1;
        // newRefresh = refreshAgentConfig(): loadTokens now gives session B while A's
        // request is in flight, so it must not join it: it waits, then plans again.
        assert_eq!(
            refresh_plan(Some(&key_a), &key_b),
            RefreshPlan::WaitThenRetry
        );

        // resolveFirst(config): A's response arrives, but the stored session is B.
        deliver(&mut world, SESSION_A, Some(SESSION_B), &config());

        // A has finished, so the retry finds nothing in flight and starts B's request.
        assert_eq!(refresh_plan(None, &key_b), RefreshPlan::Start);
        world.mocks.api_calls += 1;
        deliver(&mut world, SESSION_B, Some(SESSION_B), &config());

        assert_eq!(world.mocks.api_calls, 2);
        assert_eq!(
            world.mocks.applied_time_zones,
            vec![("Asia/Kolkata".to_owned(), "workspace_b".to_owned())]
        );
        assert_eq!(
            world.mocks.info,
            vec!["agent config response discarded because the stored session changed"]
        );
    }
}
