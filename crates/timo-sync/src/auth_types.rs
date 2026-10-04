//! The data `auth.rs` moves around: the host's environment, the live pending
//! login, and the request and response shapes.

use std::future::Future;
use std::pin::Pin;

use serde::{Deserialize, Serialize};
use tokio::task::AbortHandle;

/// What the host supplies: the clock, randomness, the browser and the
/// workspace-time reset (`Date.now`, `crypto.randomBytes`, `shell.openExternal`,
/// `clearWorkspaceTimeSession`).
pub struct AuthEnv {
    pub now_ms: Box<dyn Fn() -> i64 + Send + Sync>,
    pub random_fill: RandomFill,
    pub open_external: Box<dyn Fn(String) -> OpenFuture + Send + Sync>,
    pub clear_workspace_time: Box<dyn Fn() + Send + Sync>,
}

/// `crypto.randomBytes(n)` filling a buffer.
pub type RandomFill = Box<dyn Fn(&mut [u8]) + Send + Sync>;

pub type OpenFuture = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

impl std::fmt::Debug for AuthEnv {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthEnv").finish_non_exhaustive()
    }
}

pub(crate) struct PendingLogin {
    pub(crate) verifier: String,
    pub(crate) login_url: String,
    pub(crate) created_at: i64,
    pub(crate) expiry: AbortHandle,
}

impl Drop for PendingLogin {
    fn drop(&mut self) {
        self.expiry.abort();
    }
}

/// A copy of the live pending login (the timer handle stays in the state).
#[derive(Clone)]
pub(crate) struct PendingView {
    pub(crate) verifier: String,
    pub(crate) login_url: String,
    pub(crate) created_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExchangeBody<'a> {
    pub(crate) code: &'a str,
    pub(crate) code_verifier: &'a str,
}

/// `AgentLarkExchangeResponse`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExchangeResponse {
    pub(crate) access_token: String,
    pub(crate) refresh_token: String,
    pub(crate) user_id: String,
    pub(crate) workspace_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoginBody<'a> {
    pub(crate) email: &'a str,
    pub(crate) password: &'a str,
    pub(crate) device_name: String,
}

/// `LoginResponse`; `user` stays JSON because the renderer receives it whole.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LoginResponse {
    pub(crate) access_token: String,
    pub(crate) refresh_token: String,
    pub(crate) user: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LogoutBody<'a> {
    pub(crate) refresh_token: &'a str,
}
