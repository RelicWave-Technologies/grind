//! The Lark HTTP calls of `legacy/agent/src/main/ipc/lark.ts`: connection
//! status, the OAuth start URL, today's tasks, task creation, disconnect and the
//! manual "Sync" with its retry loop. The task cache, the workspace time zone
//! and the other services it reaches are behind [`LarkSyncHooks`].

use std::future::Future;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::api::ApiClient;
use crate::config::CallbackScheme;
use crate::error::ApiError;
use crate::http::RequestOptions;
use crate::tokens::TokenStore;
use crate::urlenc::search_params;
use crate::wire::json_body;

/// `LarkStatus`. Response fields are cast, so missing ones default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LarkStatus {
    #[serde(default)]
    pub configured: bool,
    #[serde(default)]
    pub connected: bool,
    #[serde(default)]
    pub reauth_required: bool,
    #[serde(default)]
    pub scopes: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub missing_scopes: Option<Vec<String>>,
    /// The API is unreachable; the UI may offer an owner-scoped saved task list.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offline: Option<bool>,
}

/// `LarkTask` / `CachedLarkTask`, in the order the API builds it
/// (`apps/api/src/lark/tasks.ts`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LarkTask {
    pub guid: String,
    pub summary: String,
    pub completed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    pub due: Option<f64>,
    pub created_at: Option<f64>,
    pub creator_id: Option<String>,
    pub creator_name: Option<String>,
    pub logged_ms: f64,
    pub logged_today_ms: f64,
    pub logged_total_ms: f64,
}

/// `CreateTaskInput`.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CreateTaskInput {
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due: Option<Option<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<Option<String>>,
}

#[derive(Deserialize)]
struct TasksResponse {
    tasks: Vec<LarkTask>,
}

#[derive(Deserialize)]
struct TaskResponse {
    task: LarkTask,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthorizeResponse {
    authorize_url: String,
}

/// `GET /v1/lark/status`.
pub async fn status<S: TokenStore>(api: &ApiClient<S>) -> Result<LarkStatus, ApiError> {
    api.api("/v1/lark/status", &RequestOptions::get()).await
}

/// `lark:connect`'s request: the authorize URL the system browser opens. The
/// signed return target brings the desktop app back after the browser callback.
pub async fn oauth_start<S: TokenStore>(
    api: &ApiClient<S>,
    scheme: CallbackScheme,
) -> Result<String, ApiError> {
    let query = search_params(&[("return_to", "agent"), ("callback_scheme", scheme.as_str())]);
    let res: AuthorizeResponse = api
        .api(
            &format!("/v1/lark/oauth/start?{query}"),
            &RequestOptions::get(),
        )
        .await?;
    Ok(res.authorize_url)
}

/// `myTasksPath()`: `date` is the workspace-time-zone calendar day.
#[must_use]
pub fn my_tasks_path(date_key: &str, time_zone: &str) -> String {
    format!(
        "/v1/lark/my-tasks?{}",
        search_params(&[("date", date_key), ("tz", time_zone)])
    )
}

/// `GET /v1/lark/my-tasks?...`.
pub async fn my_tasks<S: TokenStore>(
    api: &ApiClient<S>,
    path: &str,
) -> Result<Vec<LarkTask>, ApiError> {
    let res: TasksResponse = api.api(path, &RequestOptions::get()).await?;
    Ok(res.tasks)
}

/// `POST /v1/lark/tasks`.
pub async fn create_task<S: TokenStore>(
    api: &ApiClient<S>,
    input: &CreateTaskInput,
) -> Result<LarkTask, ApiError> {
    let options = RequestOptions::post(Some(json_body(input)?));
    let res: TaskResponse = api.api("/v1/lark/tasks", &options).await?;
    Ok(res.task)
}

/// `POST /v1/lark/disconnect` (no body).
pub async fn disconnect<S: TokenStore>(api: &ApiClient<S>) -> Result<(), ApiError> {
    api.api::<serde_json::Value>("/v1/lark/disconnect", &RequestOptions::post(None))
        .await?;
    Ok(())
}

/// A JavaScript-truthy member of a JSON object, as text (a non-string truthy
/// value is returned by the TypeScript as is; here it is its JSON text).
fn truthy_text(body: &serde_json::Value, key: &str) -> Option<String> {
    use serde_json::Value;
    match body.get(key)? {
        Value::Null => None,
        Value::Bool(flag) => flag.then(|| "true".to_owned()),
        Value::Number(n) => n
            .as_f64()
            .filter(|x| *x != 0.0 && !x.is_nan())
            .map(|_| n.to_string()),
        Value::String(text) => (!text.is_empty()).then(|| text.clone()),
        other => Some(other.to_string()),
    }
}

/// Port of `lark.ts::createTaskErrorMessage` (`raw` is `String(err)`).
#[must_use]
pub fn create_task_error_message(raw: &str) -> String {
    if raw.contains("409") {
        return "reauth_required".to_owned();
    }
    if let Some(start) = raw.find('{')
        && let Some(body) = raw
            .get(start..)
            .and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok())
    {
        if let Some(detail) = truthy_text(&body, "detail") {
            return detail;
        }
        match body.get("error").and_then(serde_json::Value::as_str) {
            Some("lark_create_failed") => return "Lark rejected the task".to_owned(),
            Some("internal_error") => return raw.to_owned(),
            _ => {}
        }
        if let Some(error) = truthy_text(&body, "error") {
            return error;
        }
    }
    "Could not create task in Lark".to_owned()
}

/// `LarkSyncResult`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LarkSyncResult {
    pub ok: bool,
    pub connected: bool,
    pub reauth_required: bool,
    pub tasks: Vec<LarkTask>,
    pub synced_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// The services `lark:sync` reaches besides the API.
pub trait LarkSyncHooks: Send + Sync {
    /// `myTasksPath()`; may fail with `workspace_time_unavailable`.
    fn my_tasks_path(&self) -> Result<String, String>;
    /// `refreshAgentConfig()`.
    fn refresh_agent_config(&self) -> impl Future<Output = Result<(), String>> + Send;
    /// `cacheTasks(tasks)`.
    fn cache_tasks(&self, tasks: &[LarkTask]) -> impl Future<Output = ()> + Send;
    /// `refreshTodayLedger('manual')`.
    fn refresh_today_ledger(&self) -> impl Future<Output = Result<(), String>> + Send;
    /// `withProjectedToday(tasks)`.
    fn project_today(&self, tasks: Vec<LarkTask>) -> Vec<LarkTask>;
    /// `Date.now()`.
    fn now_ms(&self) -> i64;
}

/// One attempt of the sync; `Err` is `String(err)`.
async fn sync_attempt<S: TokenStore, H: LarkSyncHooks>(
    api: &ApiClient<S>,
    hooks: &H,
) -> Result<LarkSyncResult, String> {
    let empty = |connected, reauth_required| LarkSyncResult {
        ok: false,
        connected,
        reauth_required,
        tasks: Vec::new(),
        synced_at: None,
        error: None,
    };
    // Re-check the connection first: surfaces a dropped/expired link clearly.
    let current = status(api).await.map_err(|e| e.to_string())?;
    if !current.connected {
        return Ok(empty(false, current.reauth_required));
    }
    hooks.refresh_agent_config().await?;
    // The backend refreshes the Lark token here if needed; 409 means reauth.
    let tasks = my_tasks(api, &hooks.my_tasks_path()?)
        .await
        .map_err(|e| e.to_string())?;
    hooks.cache_tasks(&tasks).await;
    hooks.refresh_today_ledger().await?;
    Ok(LarkSyncResult {
        ok: true,
        connected: true,
        reauth_required: false,
        tasks: hooks.project_today(tasks),
        synced_at: Some(hooks.now_ms()),
        error: None,
    })
}

/// `lark:sync`: refresh the connection and re-pull tasks, with up to three
/// attempts (`400 * attempt` ms apart). Distinguishes not connected, reauth
/// needed (409) and a transient failure.
pub async fn lark_sync<S: TokenStore, H: LarkSyncHooks>(
    api: &ApiClient<S>,
    hooks: &H,
) -> LarkSyncResult {
    const ATTEMPTS: u64 = 3;
    let mut last_error = "sync_failed".to_owned();
    for attempt in 1..=ATTEMPTS {
        match sync_attempt(api, hooks).await {
            Ok(result) => return result,
            Err(message) if message.contains("409") => {
                return LarkSyncResult {
                    ok: false,
                    connected: true,
                    reauth_required: true,
                    tasks: Vec::new(),
                    synced_at: None,
                    error: Some("reauth_required".to_owned()),
                };
            }
            Err(message) => {
                tracing::warn!(attempt, err = %message, "lark:sync attempt failed");
                last_error = message;
                if attempt < ATTEMPTS {
                    tokio::time::sleep(Duration::from_millis(400 * attempt)).await;
                }
            }
        }
    }
    LarkSyncResult {
        ok: false,
        connected: true,
        reauth_required: false,
        tasks: Vec::new(),
        synced_at: None,
        error: Some(last_error),
    }
}
