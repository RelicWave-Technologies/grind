//! The timer's HTTP transport. Port of
//! `legacy/agent/src/main/services/timer/syncClient.ts::HttpSyncClient`: the
//! request bodies are built by `timo_core::timer::sync_payload` (the port of
//! `lifecycle`/`segIso`); this module owns the path, the method, the 15 s
//! timeout and the receipt parsing.

use std::sync::Arc;

use futures_util::future::BoxFuture;
use serde_json::Value;
use timo_core::timer::dto::TimerSyncReceipt;
use timo_core::timer::error::SyncError;
use timo_core::timer::sync_payload::{self, Platform as CorePlatform};
use timo_core::timer::traits::SyncClient;
use timo_core::types::TimeEntry;

use crate::api::ApiClient;
use crate::config::Platform;
use crate::error::ApiError;
use crate::http::RequestOptions;
use crate::tokens::TokenStore;
use crate::wire::json_body;

/// `timeoutMs: 15_000` on both calls.
const SYNC_TIMEOUT_MS: u64 = 15_000;
/// `timeoutMs: 20_000` on the today-ledger read.
const TODAY_LEDGER_TIMEOUT_MS: u64 = 20_000;

/// `serverAlignedNow()`.
pub type ServerClock = Arc<dyn Fn() -> f64 + Send + Sync>;

#[derive(Clone)]
pub struct HttpSyncClient<S: TokenStore> {
    api: Arc<ApiClient<S>>,
    agent_version: String,
    platform: Platform,
    server_aligned_now: ServerClock,
}

impl<S: TokenStore> std::fmt::Debug for HttpSyncClient<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HttpSyncClient").finish_non_exhaustive()
    }
}

impl<S: TokenStore> HttpSyncClient<S> {
    pub fn new(
        api: Arc<ApiClient<S>>,
        agent_version: String,
        platform: Platform,
        server_aligned_now: ServerClock,
    ) -> Self {
        Self {
            api,
            agent_version,
            platform,
            server_aligned_now,
        }
    }

    fn core_platform(&self) -> CorePlatform {
        match self.platform {
            Platform::Darwin => CorePlatform::Darwin,
            Platform::Win32 => CorePlatform::Win32,
            Platform::Linux => CorePlatform::Linux,
        }
    }

    /// The synchronous half: build the body (an open entry samples the server
    /// clock HERE, at call time) and the request.
    fn prepare_create(&self, entry: &TimeEntry) -> Result<(String, RequestOptions), SyncError> {
        let mut now = || (self.server_aligned_now)();
        let body =
            sync_payload::create_body(entry, &mut now, &self.agent_version, self.core_platform())
                .map_err(|e| SyncError::Other(e.to_string()))?;
        let text = json_body(&body).map_err(|e| SyncError::Other(e.message()))?;
        let options = RequestOptions::post(Some(text)).with_timeout_ms(SYNC_TIMEOUT_MS);
        Ok(("/v1/time-entries".to_owned(), options))
    }

    fn prepare_sync(&self, entry: &TimeEntry) -> Result<(String, RequestOptions), SyncError> {
        let mut now = || (self.server_aligned_now)();
        let body = sync_payload::sync_body(entry, &mut now)
            .map_err(|e| SyncError::Other(e.to_string()))?;
        let text = json_body(&body).map_err(|e| SyncError::Other(e.message()))?;
        let options = RequestOptions::put(Some(text)).with_timeout_ms(SYNC_TIMEOUT_MS);
        Ok((format!("/v1/time-entries/{}/sync", entry.id), options))
    }

    fn send(
        &self,
        prepared: Result<(String, RequestOptions), SyncError>,
    ) -> BoxFuture<'static, Result<TimerSyncReceipt, SyncError>> {
        let api = Arc::clone(&self.api);
        Box::pin(async move {
            let (path, options) = prepared?;
            let response: Value = api.api(&path, &options).await.map_err(to_sync_error)?;
            parse_receipt(response)
        })
    }
}

/// `TimerSyncReceipt.parse(response)`.
fn parse_receipt(response: Value) -> Result<TimerSyncReceipt, SyncError> {
    let receipt: TimerSyncReceipt =
        serde_json::from_value(response).map_err(|e| SyncError::Other(e.to_string()))?;
    receipt
        .validate()
        .map_err(|e| SyncError::Other(e.to_string()))?;
    Ok(receipt)
}

/// An `HttpError` keeps its status (`404` means "create it again"); anything
/// else is just its message.
fn to_sync_error(err: ApiError) -> SyncError {
    match err {
        ApiError::Http { path, status, body } => SyncError::Http { path, status, body },
        other => SyncError::Other(other.message()),
    }
}

impl<S: TokenStore> SyncClient for HttpSyncClient<S> {
    fn create(&self, entry: &TimeEntry) -> BoxFuture<'static, Result<TimerSyncReceipt, SyncError>> {
        self.send(self.prepare_create(entry))
    }

    fn sync(&self, entry: &TimeEntry) -> BoxFuture<'static, Result<TimerSyncReceipt, SyncError>> {
        self.send(self.prepare_sync(entry))
    }
}

/// `GET /v1/agent/today-ledger?from=..&to=..` (the path is built by the
/// hydrator): 20 s timeout, the body returned as JSON for the caller to parse
/// with `TodayLedgerResponse.parse`. An error is `String(err)`.
pub async fn fetch_today_ledger<S: TokenStore>(
    api: &ApiClient<S>,
    path: &str,
) -> Result<Value, String> {
    let options = RequestOptions::get().with_timeout_ms(TODAY_LEDGER_TIMEOUT_MS);
    api.api(path, &options).await.map_err(|e| e.to_string())
}
