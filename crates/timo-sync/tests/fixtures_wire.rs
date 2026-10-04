//! Wire-format parity: the Rust bytes must equal what the REAL TypeScript
//! produced (`heartbeatPayload.ts`, `URLSearchParams`, `encodeURIComponent`, and the
//! copied lark.ts error mapper), case by case, byte for byte.
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

use serde_json::Value;
use support::{f, fixture, s};
use timo_sync::Platform;
use timo_sync::heartbeat_payload::{
    AccessibilityPermission, CaptureHealth, HeartbeatArgs, HeartbeatTimerStatus,
    LaunchAtLoginState, LaunchOrigin, PauseReason, PermissionSnapshot, ScreenPermission,
    ScreenPermissionState, ScreenPermissionStatus, StartupSnapshot, build_heartbeat_request,
};
use timo_sync::lark::create_task_error_message;
use timo_sync::urlenc::{encode_uri_component, search_params};
use timo_sync::wire::json_body;

fn platform(v: &Value) -> Platform {
    match s(v).as_str() {
        "darwin" => Platform::Darwin,
        "win32" => Platform::Win32,
        _ => Platform::Linux,
    }
}

fn pause(v: &Value) -> Option<PauseReason> {
    match v.as_str() {
        Some("IDLE") => Some(PauseReason::Idle),
        Some("MANUAL") => Some(PauseReason::Manual),
        Some("PERMISSION_REQUIRED") => Some(PauseReason::PermissionRequired),
        _ => None,
    }
}

fn status(v: &Value) -> HeartbeatTimerStatus {
    if v["state"] == "IDLE" {
        return HeartbeatTimerStatus::Idle;
    }
    HeartbeatTimerStatus::Running {
        entry_id: s(&v["entryId"]),
        revision: v["revision"].as_i64().expect("integer revision"),
        paused: v["paused"].as_bool().expect("paused"),
        pause_reason: pause(&v["pauseReason"]),
    }
}

fn permissions(v: &Value) -> PermissionSnapshot {
    let screen = &v["screen"];
    let a = &v["accessibility"];
    PermissionSnapshot {
        screen: ScreenPermission {
            status: match s(&screen["status"]).as_str() {
                "granted" => ScreenPermissionStatus::Granted,
                "denied" => ScreenPermissionStatus::Denied,
                "restricted" => ScreenPermissionStatus::Restricted,
                "not-determined" => ScreenPermissionStatus::NotDetermined,
                _ => ScreenPermissionStatus::Unknown,
            },
            health: match s(&screen["health"]).as_str() {
                "ok" => CaptureHealth::Ok,
                "no-permission" => CaptureHealth::NoPermission,
                "empty" => CaptureHealth::Empty,
                "error" => CaptureHealth::Error,
                _ => CaptureHealth::Unknown,
            },
            state: match s(&screen["state"]).as_str() {
                "ok" => ScreenPermissionState::Ok,
                "needs-grant" => ScreenPermissionState::NeedsGrant,
                "needs-settings" => ScreenPermissionState::NeedsSettings,
                _ => ScreenPermissionState::NeedsRestart,
            },
        },
        accessibility: AccessibilityPermission {
            trusted: a["trusted"].as_bool().unwrap(),
            ready: a["ready"].as_bool().unwrap(),
            recording: a["recording"].as_bool().unwrap(),
            capturing: a["capturing"].as_bool().unwrap(),
            hook_running: a["hookRunning"].as_bool().unwrap(),
        },
    }
}

fn startup(v: &Value) -> StartupSnapshot {
    StartupSnapshot {
        state: match s(&v["state"]).as_str() {
            "READY" => LaunchAtLoginState::Ready,
            "NEEDS_INSTALL" => LaunchAtLoginState::NeedsInstall,
            "NEEDS_REGISTRATION" => LaunchAtLoginState::NeedsRegistration,
            "NEEDS_APPROVAL" => LaunchAtLoginState::NeedsApproval,
            "NEEDS_REPAIR" => LaunchAtLoginState::NeedsRepair,
            "BLOCKED" => LaunchAtLoginState::Blocked,
            _ => LaunchAtLoginState::Unavailable,
        },
        ready: v["ready"].as_bool().unwrap(),
        opened_at_login: v["openedAtLogin"].as_bool().unwrap(),
        origin: match s(&v["origin"]).as_str() {
            "LOGIN_ITEM" => LaunchOrigin::LoginItem,
            "USER" => LaunchOrigin::User,
            _ => LaunchOrigin::Unknown,
        },
    }
}

#[test]
fn build_heartbeat_request_matches_the_typescript_bytes() {
    let cases = fixture("wire", "build_heartbeat_request");
    let mut errors = 0;
    for (i, case) in cases.iter().enumerate() {
        let input = &case.input;
        let args = HeartbeatArgs {
            agent_version: s(&input["agentVersion"]),
            platform: platform(&input["platform"]),
            timer_status: status(&input["timerStatus"]),
            permissions: input.get("permissions").map(permissions),
            startup: input.get("startup").map(startup),
            observed_at: f(&input["observedAt"]),
        };
        let got = build_heartbeat_request(args).and_then(|r| json_body(&r));
        if let Some(message) = case.output.get("error") {
            errors += 1;
            assert_eq!(got.unwrap_err().message(), s(message), "case {i}");
        } else {
            assert_eq!(got.unwrap(), s(&case.output), "case {i}: {input}");
        }
    }
    assert!(
        cases.len() >= 500 && errors > 0,
        "{} cases, {errors} errors",
        cases.len()
    );
}

#[test]
fn search_params_match_url_search_params() {
    for (i, case) in fixture("wire", "search_params").iter().enumerate() {
        let pairs: Vec<(String, String)> = case
            .input
            .as_array()
            .unwrap()
            .iter()
            .map(|p| (s(&p[0]), s(&p[1])))
            .collect();
        let refs: Vec<(&str, &str)> = pairs
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        assert_eq!(
            search_params(&refs),
            s(&case.output),
            "case {i}: {}",
            case.input
        );
    }
}

#[test]
fn encode_uri_component_matches_javascript() {
    for (i, case) in fixture("wire", "encode_uri_component").iter().enumerate() {
        assert_eq!(
            encode_uri_component(&s(&case.input)),
            s(&case.output),
            "case {i}: {}",
            case.input
        );
    }
}

#[test]
fn create_task_error_message_matches_lark_ts() {
    for (i, case) in fixture("lark", "create_task_error_message")
        .iter()
        .enumerate()
    {
        // JavaScript returns a truthy non-string `error` as is (a number, say); here it is its JSON text.
        let want = case
            .output
            .as_str()
            .map_or_else(|| case.output.to_string(), str::to_owned);
        assert_eq!(
            create_task_error_message(&s(&case.input)),
            want,
            "case {i}: {}",
            case.input
        );
    }
}
