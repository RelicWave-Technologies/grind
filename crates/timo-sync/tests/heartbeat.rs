//! Port of `legacy/agent/src/main/services/heartbeat.test.ts` (6 tests: the
//! request and the response handling) and the tick orchestration of SC-47. The
//! timer, probes and clock are recording hooks; the API is a loopback server.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::string_slice,
    clippy::too_many_lines,
    clippy::too_many_arguments,
    reason = "test code: a failed assertion is the failure report"
)]

mod support;

use std::sync::{Arc, Mutex};

use support::{MockServer, Reply, tokens};
use timo_sync::heartbeat::{DrainTrigger, Heartbeat, HeartbeatHooks, TickOutcome};
use timo_sync::heartbeat_payload::{
    AccessibilityPermission, CaptureHealth, HeartbeatTimerStatus, LaunchAtLoginState, LaunchOrigin,
    PauseReason, PermissionSnapshot, ScreenPermission, ScreenPermissionState,
    ScreenPermissionStatus, StartupSnapshot,
};
use timo_sync::tokens::MemoryTokenStore;
use timo_sync::{ApiClient, Platform};

struct Hooks {
    calls: Mutex<Vec<String>>,
    config_version: Mutex<String>,
    status: HeartbeatTimerStatus,
    permissions: Result<PermissionSnapshot, String>,
    agent_version: String,
    clock_offset: Mutex<f64>,
    noted: Mutex<Vec<(String, i64, i64)>>,
}

impl Hooks {
    fn new() -> Self {
        Self {
            calls: Mutex::default(),
            config_version: Mutex::new("version-1".to_owned()),
            status: HeartbeatTimerStatus::Idle,
            permissions: Ok(snapshot(
                CaptureHealth::Ok,
                ScreenPermissionState::Ok,
                false,
            )),
            agent_version: "9.8.7".to_owned(),
            clock_offset: Mutex::new(0.0),
            noted: Mutex::default(),
        }
    }

    fn log(&self, what: &str) {
        self.calls.lock().unwrap().push(what.to_owned());
    }

    fn calls(&self) -> Vec<String> {
        self.calls.lock().unwrap().clone()
    }
}

fn snapshot(
    health: CaptureHealth,
    state: ScreenPermissionState,
    recording: bool,
) -> PermissionSnapshot {
    PermissionSnapshot {
        screen: ScreenPermission {
            status: ScreenPermissionStatus::Granted,
            health,
            state,
        },
        accessibility: AccessibilityPermission {
            trusted: true,
            ready: true,
            recording,
            capturing: false,
            hook_running: false,
        },
    }
}

impl HeartbeatHooks for Hooks {
    async fn drain_timer_sync_now(&self) -> Result<(), String> {
        self.log("drainTimerSyncNow(heartbeat)");
        Ok(())
    }
    fn timer_status(&self) -> HeartbeatTimerStatus {
        self.status.clone()
    }
    fn timer_liveness(&self) {
        self.log("timer.heartbeat()");
    }
    async fn permissions(&self) -> Result<PermissionSnapshot, String> {
        self.log("inspect()");
        self.permissions.clone()
    }
    fn startup(&self) -> StartupSnapshot {
        StartupSnapshot {
            state: LaunchAtLoginState::Ready,
            ready: true,
            opened_at_login: true,
            origin: LaunchOrigin::LoginItem,
        }
    }
    fn agent_version(&self) -> String {
        self.agent_version.clone()
    }
    fn server_aligned_now(&self) -> f64 {
        1_791_133_383_891.262_7
    }
    fn device_now_ms(&self) -> i64 {
        1_791_133_383_000
    }
    fn server_clock_offset_ms(&self) -> f64 {
        *self.clock_offset.lock().unwrap()
    }
    fn note_server_time(&self, server_time: &str, started: i64, received: i64) -> Option<f64> {
        self.noted
            .lock()
            .unwrap()
            .push((server_time.to_owned(), started, received));
        Some(*self.clock_offset.lock().unwrap())
    }
    fn has_deferred_clock_correction(&self) -> bool {
        false
    }
    fn request_timer_drain(&self, trigger: DrainTrigger) {
        self.log(&format!("requestTimerDrain({trigger:?})"));
    }
    fn accept_server_finalization(&self, entry_id: &str, ended_at_ms: f64) {
        self.log(&format!(
            "acceptServerFinalization({entry_id},{ended_at_ms})"
        ));
    }
    fn config_version(&self) -> String {
        self.config_version.lock().unwrap().clone()
    }
    fn request_config_refresh(&self) {
        self.log("refreshAgentConfig()");
    }
    fn request_activity_drain(&self, trigger: DrainTrigger) {
        self.log(&format!("drainActivityNow({trigger:?})"));
    }
}

struct Rig {
    heartbeat: Arc<Heartbeat<MemoryTokenStore, Hooks>>,
    hooks: Arc<Hooks>,
    server: MockServer,
}

async fn rig(hooks: Hooks, reply: Reply) -> Rig {
    let server = MockServer::sequence(vec![reply]).await;
    let store = Arc::new(MemoryTokenStore::new(Some(tokens("a", "r"))));
    let api = Arc::new(ApiClient::new(&server.base, store).unwrap());
    let hooks = Arc::new(hooks);
    let heartbeat = Heartbeat::new(api, Arc::clone(&hooks), Platform::Darwin);
    Rig {
        heartbeat,
        hooks,
        server,
    }
}

fn ok(config_version: &str) -> Reply {
    Reply::json(
        200,
        &format!(
            r#"{{"ok":true,"serverTime":"2026-07-04T00:00:00.000Z","configVersion":"{config_version}"}}"#
        ),
    )
}

#[tokio::test]
async fn refreshes_agent_config_when_the_server_config_version_changes() {
    let r = rig(Hooks::new(), ok("version-2")).await;

    assert_eq!(r.heartbeat.tick().await, TickOutcome::Sent);

    let calls = r.hooks.calls();
    assert_eq!(
        calls
            .iter()
            .filter(|c| *c == "refreshAgentConfig()")
            .count(),
        1
    );
    assert!(calls.contains(&"drainTimerSyncNow(heartbeat)".to_owned()));
    assert!(calls.contains(&"drainActivityNow(Heartbeat)".to_owned()));
}

#[tokio::test]
async fn sends_the_packaged_app_version_in_the_heartbeat_payload() {
    let r = rig(Hooks::new(), ok("version-1")).await;

    r.heartbeat.tick().await;

    let request = &r.server.requests()[0];
    assert_eq!(
        (request.method.as_str(), request.path.as_str()),
        ("POST", "/v1/agent/heartbeat")
    );
    assert!(
        request
            .body
            .starts_with(r#"{"agentVersion":"9.8.7","platform":"darwin","state":"IDLE","#),
        "{}",
        request.body
    );
}

#[tokio::test]
async fn sends_the_local_desktop_permission_snapshot_in_the_heartbeat_payload() {
    let mut hooks = Hooks::new();
    hooks.permissions = Ok(snapshot(
        CaptureHealth::Empty,
        ScreenPermissionState::NeedsRestart,
        true,
    ));
    let r = rig(hooks, ok("version-1")).await;

    r.heartbeat.tick().await;

    let body = &r.server.requests()[0].body;
    assert!(
        body.contains(
            r#""permissions":{"screen":{"status":"granted","health":"empty","state":"needs-restart"},"accessibility":{"trusted":true,"ready":true,"recording":true,"capturing":false,"hookRunning":false}}"#
        ),
        "{body}"
    );
}

#[tokio::test]
async fn sends_launch_at_login_health_without_local_paths() {
    let r = rig(Hooks::new(), ok("version-1")).await;

    r.heartbeat.tick().await;

    let body = &r.server.requests()[0].body;
    assert!(
        body.ends_with(r#""startup":{"state":"READY","ready":true,"openedAtLogin":true,"origin":"LOGIN_ITEM"}}"#),
        "{body}"
    );
}

#[tokio::test]
async fn does_not_refresh_agent_config_when_the_server_version_matches() {
    let r = rig(Hooks::new(), ok("version-1")).await;

    r.heartbeat.tick().await;

    let calls = r.hooks.calls();
    assert!(calls.contains(&"drainActivityNow(Heartbeat)".to_owned()));
    assert!(calls.contains(&"drainTimerSyncNow(heartbeat)".to_owned()));
    assert!(!calls.contains(&"refreshAgentConfig()".to_owned()));
}

#[tokio::test]
async fn keeps_heartbeat_errors_contained_when_local_permission_collection_fails() {
    let mut hooks = Hooks::new();
    hooks.permissions = Err("permission probe failed".to_owned());
    let r = rig(hooks, ok("version-1")).await;

    let outcome = r.heartbeat.tick().await;

    assert_eq!(
        outcome,
        TickOutcome::Failed("permission probe failed".to_owned())
    );
    assert_eq!(r.server.count(), 0, "no request is sent");
}

// ---- SC-47: order and response handling ----

#[tokio::test]
async fn a_running_timer_is_stamped_then_checkpointed_with_the_fractional_clock_truncated() {
    let mut hooks = Hooks::new();
    hooks.status = HeartbeatTimerStatus::Running {
        entry_id: "entry-1".to_owned(),
        revision: 0,
        paused: false,
        pause_reason: None,
    };
    let r = rig(hooks, ok("version-1")).await;

    r.heartbeat.tick().await;

    // Order: drain, liveness, inspect (observedAt is read before the probe).
    assert_eq!(
        r.hooks.calls()[..3],
        [
            "drainTimerSyncNow(heartbeat)",
            "timer.heartbeat()",
            "inspect()"
        ]
    );
    let body = &r.server.requests()[0].body;
    assert!(
        body.contains(r#""state":"RUNNING","activeEntryId":"entry-1","trackingProtocolVersion":2,"timerCheckpoint":{"entryId":"entry-1","revision":1,"state":"RUNNING","observedAt":"2026-10-04T"#),
        "{body}"
    );
    assert!(
        body.contains(r#""observedAt":"2026-10-04T17:03:03.891Z""#),
        "{body}"
    );
}

#[tokio::test]
async fn a_paused_timer_is_not_stamped_and_a_manual_pause_reports_paused_idle() {
    let mut hooks = Hooks::new();
    hooks.status = HeartbeatTimerStatus::Running {
        entry_id: "entry-m".to_owned(),
        revision: 9,
        paused: true,
        pause_reason: Some(PauseReason::Manual),
    };
    let r = rig(hooks, ok("version-1")).await;

    r.heartbeat.tick().await;

    assert!(!r.hooks.calls().contains(&"timer.heartbeat()".to_owned()));
    assert!(
        r.server.requests()[0]
            .body
            .contains(r#""state":"PAUSED_IDLE","activeEntryId":"entry-m""#)
    );
}

#[tokio::test]
async fn the_server_time_teaches_the_clock_with_the_request_round_trip() {
    let r = rig(Hooks::new(), ok("version-1")).await;

    r.heartbeat.tick().await;

    let noted = r.hooks.noted.lock().unwrap().clone();
    assert_eq!(
        noted,
        vec![(
            "2026-07-04T00:00:00.000Z".to_owned(),
            1_791_133_383_000,
            1_791_133_383_000
        )]
    );
    assert_eq!(
        r.heartbeat.status().0.as_deref(),
        Some("2026-07-04T00:00:00.000Z")
    );
}

#[tokio::test]
async fn needs_sync_requests_a_timer_drain() {
    let reply = Reply::json(
        200,
        r#"{"ok":true,"serverTime":"2026-07-04T00:00:00.000Z","configVersion":"version-1","timer":{"disposition":"needs_sync","entryId":"e","serverRevision":null,"endedAt":null,"closeReason":null}}"#,
    );
    let r = rig(Hooks::new(), reply).await;

    r.heartbeat.tick().await;

    assert!(
        r.hooks
            .calls()
            .contains(&"requestTimerDrain(Heartbeat)".to_owned())
    );
}

#[tokio::test]
async fn a_finalized_checkpoint_is_accepted_at_the_server_end_time() {
    let reply = Reply::json(
        200,
        r#"{"ok":true,"serverTime":"2026-07-04T00:00:00.000Z","configVersion":"version-1","timer":{"disposition":"finalized","entryId":"e1","serverRevision":3,"endedAt":"2026-07-04T00:00:01.500Z","closeReason":"LEASE_EXPIRED"}}"#,
    );
    let r = rig(Hooks::new(), reply).await;

    r.heartbeat.tick().await;

    assert!(
        r.hooks
            .calls()
            .contains(&"acceptServerFinalization(e1,1783123201500)".to_owned()),
        "{:?}",
        r.hooks.calls()
    );
}

#[tokio::test]
async fn a_conflict_without_an_end_time_accepts_nothing() {
    let reply = Reply::json(
        200,
        r#"{"ok":true,"serverTime":"2026-07-04T00:00:00.000Z","configVersion":"version-1","timer":{"disposition":"conflict","entryId":"e1","serverRevision":3,"endedAt":null,"closeReason":null}}"#,
    );
    let r = rig(Hooks::new(), reply).await;

    r.heartbeat.tick().await;

    assert!(
        !r.hooks
            .calls()
            .iter()
            .any(|c| c.starts_with("acceptServerFinalization"))
    );
}

#[tokio::test]
async fn an_unauthorized_session_stops_the_heartbeat_and_other_errors_do_not() {
    let server = MockServer::sequence(vec![Reply::json(500, "boom")]).await;
    let api =
        Arc::new(ApiClient::new(&server.base, Arc::new(MemoryTokenStore::new(None))).unwrap());
    let hb = Heartbeat::new(api, Arc::new(Hooks::new()), Platform::Darwin);
    hb.start();
    assert!(hb.status().1, "running after start");

    // No tokens: api() throws UnauthorizedError('no_tokens').
    assert_eq!(hb.tick().await, TickOutcome::Unauthorized);

    assert!(!hb.status().1, "stopped itself");
}

#[tokio::test]
async fn a_server_error_is_logged_and_the_heartbeat_keeps_running() {
    let r = rig(Hooks::new(), Reply::json(500, "boom")).await;
    r.heartbeat.start();

    let outcome = r.heartbeat.tick().await;

    assert!(matches!(outcome, TickOutcome::Failed(_)));
    assert!(r.heartbeat.status().1);
    r.heartbeat.stop();
}
