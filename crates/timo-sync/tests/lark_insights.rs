//! The Lark and insights calls of `ipc/lark.ts` and `ipc/insights.ts`.
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
use timo_sync::insights::{InsightsToday, insights_today};
use timo_sync::lark::{
    CreateTaskInput, LarkSyncHooks, LarkTask, create_task, create_task_error_message, disconnect,
    lark_sync, my_tasks, my_tasks_path, oauth_start, status,
};
use timo_sync::tokens::MemoryTokenStore;
use timo_sync::{ApiClient, CallbackScheme};

fn api(server: &MockServer) -> ApiClient<MemoryTokenStore> {
    ApiClient::new(
        &server.base,
        Arc::new(MemoryTokenStore::new(Some(tokens("a", "r")))),
    )
    .unwrap()
}

const TASK: &str = r#"{"guid":"g1","summary":"Write","completed":false,"url":"https://l/g1","due":null,"createdAt":null,"creatorId":null,"creatorName":null,"loggedMs":0,"loggedTodayMs":5,"loggedTotalMs":9}"#;

#[test]
fn my_tasks_path_encodes_the_date_and_zone_like_url_search_params() {
    assert_eq!(
        my_tasks_path("2026-10-04", "Asia/Kolkata"),
        "/v1/lark/my-tasks?date=2026-10-04&tz=Asia%2FKolkata"
    );
    assert_eq!(
        my_tasks_path("2026-10-04", "UTC"),
        "/v1/lark/my-tasks?date=2026-10-04&tz=UTC"
    );
}

#[tokio::test]
async fn status_oauth_start_tasks_create_and_disconnect_use_the_documented_endpoints() {
    let server = MockServer::sequence(vec![
        Reply::json(
            200,
            r#"{"configured":true,"connected":true,"reauthRequired":false,"scopes":["task"]}"#,
        ),
        Reply::json(
            200,
            r#"{"authorizeUrl":"https://open.larksuite.com/authorize"}"#,
        ),
        Reply::json(200, &format!(r#"{{"tasks":[{TASK}]}}"#)),
        Reply::json(200, &format!(r#"{{"task":{TASK}}}"#)),
        Reply::json(200, "{}"),
    ])
    .await;
    let api = api(&server);

    let s = status(&api).await.unwrap();
    let url = oauth_start(&api, CallbackScheme::Timo).await.unwrap();
    let tasks = my_tasks(&api, &my_tasks_path("2026-10-04", "UTC"))
        .await
        .unwrap();
    let created = create_task(
        &api,
        &CreateTaskInput {
            summary: "x".into(),
            due: Some(None),
            description: None,
        },
    )
    .await
    .unwrap();
    disconnect(&api).await.unwrap();

    assert!(s.connected && s.scopes == ["task"]);
    assert_eq!(url, "https://open.larksuite.com/authorize");
    assert_eq!(tasks[0].logged_today_ms.to_bits(), 5.0_f64.to_bits());
    assert_eq!(created.guid, "g1");
    let seen: Vec<(String, String)> = server
        .requests()
        .into_iter()
        .map(|r| (r.method, r.path))
        .collect();
    assert_eq!(
        seen,
        [
            ("GET", "/v1/lark/status"),
            (
                "GET",
                "/v1/lark/oauth/start?return_to=agent&callback_scheme=timo"
            ),
            ("GET", "/v1/lark/my-tasks?date=2026-10-04&tz=UTC"),
            ("POST", "/v1/lark/tasks"),
            ("POST", "/v1/lark/disconnect"),
        ]
        .map(|(m, p)| (m.to_owned(), p.to_owned()))
    );
    assert_eq!(server.requests()[3].body, r#"{"summary":"x","due":null}"#);
    assert_eq!(server.requests()[4].body, "");
}

#[test]
fn create_task_error_messages_follow_lark_ts() {
    assert_eq!(
        create_task_error_message("HttpError: /v1/lark/tasks 409: x"),
        "reauth_required"
    );
    assert_eq!(
        create_task_error_message(
            r#"HttpError: /v1/lark/tasks 400: {"error":"lark_create_failed"}"#
        ),
        "Lark rejected the task"
    );
    assert_eq!(
        create_task_error_message(
            r#"HttpError: /v1/lark/tasks 400: {"error":"bad","detail":"No summary"}"#
        ),
        "No summary"
    );
    let internal = r#"HttpError: /v1/lark/tasks 500: {"error":"internal_error"}"#;
    assert_eq!(create_task_error_message(internal), internal);
    assert_eq!(
        create_task_error_message(r#"x {"error":"custom"}"#),
        "custom"
    );
    assert_eq!(
        create_task_error_message("x {not json"),
        "Could not create task in Lark"
    );
    assert_eq!(
        create_task_error_message("network down"),
        "Could not create task in Lark"
    );
}

struct Hooks {
    log: Mutex<Vec<String>>,
}

impl LarkSyncHooks for Hooks {
    fn my_tasks_path(&self) -> Result<String, String> {
        Ok(my_tasks_path("2026-10-04", "UTC"))
    }
    async fn refresh_agent_config(&self) -> Result<(), String> {
        self.log.lock().unwrap().push("config".into());
        Ok(())
    }
    async fn cache_tasks(&self, tasks: &[LarkTask]) {
        self.log
            .lock()
            .unwrap()
            .push(format!("cache {}", tasks.len()));
    }
    async fn refresh_today_ledger(&self) -> Result<(), String> {
        self.log.lock().unwrap().push("ledger".into());
        Ok(())
    }
    fn project_today(&self, tasks: Vec<LarkTask>) -> Vec<LarkTask> {
        tasks
    }
    fn now_ms(&self) -> i64 {
        42
    }
}

#[tokio::test(start_paused = true)]
async fn lark_sync_runs_the_steps_in_order_and_reports_ok() {
    let server = MockServer::sequence(vec![
        Reply::json(
            200,
            r#"{"configured":true,"connected":true,"reauthRequired":false,"scopes":[]}"#,
        ),
        Reply::json(200, &format!(r#"{{"tasks":[{TASK}]}}"#)),
    ])
    .await;
    let hooks = Hooks {
        log: Mutex::default(),
    };

    let result = lark_sync(&api(&server), &hooks).await;

    assert!(result.ok && result.connected && !result.reauth_required);
    assert_eq!(result.synced_at, Some(42));
    assert_eq!(*hooks.log.lock().unwrap(), ["config", "cache 1", "ledger"]);
}

#[tokio::test(start_paused = true)]
async fn lark_sync_stops_early_when_not_connected_and_reports_reauth() {
    let server = MockServer::sequence(vec![Reply::json(
        200,
        r#"{"configured":true,"connected":false,"reauthRequired":true,"scopes":[]}"#,
    )])
    .await;

    let result = lark_sync(
        &api(&server),
        &Hooks {
            log: Mutex::default(),
        },
    )
    .await;

    assert!(!result.ok && !result.connected && result.reauth_required && result.error.is_none());
    assert_eq!(server.count(), 1);
}

#[tokio::test(start_paused = true)]
async fn lark_sync_409_means_reauth_and_is_not_retried() {
    let server = MockServer::sequence(vec![Reply::json(409, "reauth")]).await;

    let result = lark_sync(
        &api(&server),
        &Hooks {
            log: Mutex::default(),
        },
    )
    .await;

    assert!(!result.ok && result.connected && result.reauth_required);
    assert_eq!(result.error.as_deref(), Some("reauth_required"));
    assert_eq!(server.count(), 1);
}

#[tokio::test(start_paused = true)]
async fn lark_sync_retries_three_times_then_reports_the_last_error() {
    let server = MockServer::start(|_, _| Reply::json(500, "boom")).await;

    let result = lark_sync(
        &api(&server),
        &Hooks {
            log: Mutex::default(),
        },
    )
    .await;

    assert!(!result.ok && result.connected && !result.reauth_required);
    assert_eq!(server.count(), 3);
    assert_eq!(
        result.error.as_deref(),
        Some("HttpError: /v1/lark/status 500: boom")
    );
}

#[tokio::test]
async fn insights_encodes_the_zone_and_falls_back_to_zeros() {
    let body = r#"{"day":"2026-10-04","score":{"score":80,"trackedMinutes":10,"engagedMinutes":8,"protectedMinutes":1,"idleMinutes":1},"totals":{"keystrokes":5,"clicks":3,"mouseDistancePx":100,"scrollEvents":2},"byHour":[0,1]}"#;
    let server = MockServer::sequence(vec![Reply::json(200, body), Reply::json(500, "no")]).await;
    let api = api(&server);

    let ok = insights_today(&api, "America/New_York", unreachable_day).await;
    let fallback = insights_today(&api, "Asia/Kolkata", || "2026-10-04".to_owned()).await;

    assert_eq!(ok.score.score.to_bits(), 80.0_f64.to_bits());
    assert_eq!(
        server.requests()[0].path,
        "/v1/insights/score?tz=America%2FNew_York"
    );
    assert_eq!(fallback, InsightsToday::empty("2026-10-04".to_owned()));
    assert_eq!(fallback.by_hour.len(), 24);
}

fn unreachable_day() -> String {
    "unused".to_owned()
}
