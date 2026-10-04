//! The 60-second heartbeat. Port of
//! `legacy/agent/src/main/services/heartbeat.ts` (SC-47 in the inventory): the
//! request, the response handling, and the order of everything around them.
//! What the heartbeat reaches into (the timer, readiness probes, the server
//! clock, drains) is behind [`HeartbeatHooks`].

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Deserialize;
use timo_core::js::date::{DateParse, parse};
use timo_core::js::math::abs;
use timo_core::js::number::sub;
use tokio::task::JoinHandle;

use crate::api::ApiClient;
use crate::error::ApiError;
use crate::heartbeat_payload::{
    HeartbeatArgs, HeartbeatTimerStatus, PermissionSnapshot, StartupSnapshot,
    build_heartbeat_request,
};
use crate::http::RequestOptions;
use crate::tokens::TokenStore;
use crate::wire::json_body;

/// `HEARTBEAT_INTERVAL_MS`.
pub const HEARTBEAT_INTERVAL_MS: u64 = 60_000;

/// `TimerSyncDrainReason` / `ActivitySyncDrainReason` as the heartbeat uses them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrainTrigger {
    Heartbeat,
    Auth,
}

/// Port of `HeartbeatResponse` (cast, not parsed, in TypeScript: so lenient).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatResponse {
    #[serde(default)]
    pub server_time: String,
    #[serde(default)]
    pub config_version: String,
    #[serde(default)]
    pub timer: Option<TimerDisposition>,
}

/// `HeartbeatResponse.timer`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimerDisposition {
    pub disposition: String,
    #[serde(default)]
    pub entry_id: String,
    #[serde(default)]
    pub ended_at: Option<String>,
    #[serde(default)]
    pub close_reason: Option<String>,
}

/// The collaborators the TypeScript imports as modules.
pub trait HeartbeatHooks: Send + Sync + 'static {
    /// `await drainTimerSyncNow('heartbeat')`; a failure ends the tick.
    fn drain_timer_sync_now(&self) -> impl Future<Output = Result<(), String>> + Send;
    /// `getTimerService().status()`.
    fn timer_status(&self) -> HeartbeatTimerStatus;
    /// `timerService.heartbeat()`: stamp liveness (called only while accruing).
    fn timer_liveness(&self);
    /// `getTrackingReadinessService().inspect()` permissions; a failure ends the tick.
    fn permissions(&self) -> impl Future<Output = Result<PermissionSnapshot, String>> + Send;
    /// `currentStartupSnapshot()`.
    fn startup(&self) -> StartupSnapshot;
    /// `app.getVersion() || AGENT_VERSION`.
    fn agent_version(&self) -> String;
    /// `serverAlignedNow()`.
    fn server_aligned_now(&self) -> f64;
    /// `Date.now()`: the device clock, for the round-trip measurement.
    fn device_now_ms(&self) -> i64;
    /// `serverClockOffsetMs()`.
    fn server_clock_offset_ms(&self) -> f64;
    /// `noteServerTime(serverTime, requestStartedAt, receivedAt)`.
    fn note_server_time(&self, server_time: &str, started: i64, received: i64) -> Option<f64>;
    /// `hasDeferredServerClockCorrection()`, for the log line.
    fn has_deferred_clock_correction(&self) -> bool;
    /// `requestTimerDrain('heartbeat')`: fire and forget.
    fn request_timer_drain(&self, trigger: DrainTrigger);
    /// `acceptServerFinalization(entryId, endedAtMs)` then
    /// `broadcast('timer:status:push', status)`.
    fn accept_server_finalization(&self, entry_id: &str, ended_at_ms: f64);
    /// `getAgentConfigVersion()`.
    fn config_version(&self) -> String;
    /// `refreshAgentConfig()`: fire and forget.
    fn request_config_refresh(&self);
    /// `drainActivityNow(trigger)`: fire and forget (throttled by the drain).
    fn request_activity_drain(&self, trigger: DrainTrigger);
}

/// What a tick ended as.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TickOutcome {
    Sent,
    /// `UnauthorizedError`: the heartbeat stopped itself.
    Unauthorized,
    Failed(String),
}

enum TickError {
    Api(ApiError),
    Hook(String),
}

impl From<ApiError> for TickError {
    fn from(e: ApiError) -> Self {
        Self::Api(e)
    }
}

#[derive(Debug)]
pub struct Heartbeat<S: TokenStore, H: HeartbeatHooks> {
    api: Arc<ApiClient<S>>,
    hooks: Arc<H>,
    platform: crate::config::Platform,
    last_heartbeat_at: Mutex<Option<String>>,
    timer: Mutex<Option<JoinHandle<()>>>,
}

impl<S: TokenStore, H: HeartbeatHooks> Heartbeat<S, H> {
    pub fn new(
        api: Arc<ApiClient<S>>,
        hooks: Arc<H>,
        platform: crate::config::Platform,
    ) -> Arc<Self> {
        Arc::new(Self {
            api,
            hooks,
            platform,
            last_heartbeat_at: Mutex::new(None),
            timer: Mutex::new(None),
        })
    }

    /// `getStatus()`.
    #[must_use]
    pub fn status(&self) -> (Option<String>, bool) {
        let last = self.last_heartbeat_at.lock().ok().and_then(|g| g.clone());
        let running = self.timer.lock().is_ok_and(|g| g.is_some());
        (last, running)
    }

    /// `tick()`.
    pub async fn tick(&self) -> TickOutcome {
        match self.try_tick().await {
            Ok(()) => TickOutcome::Sent,
            Err(TickError::Api(err)) if err.is_unauthorized() => {
                tracing::warn!("heartbeat unauthorized; stopping");
                self.stop();
                TickOutcome::Unauthorized
            }
            Err(TickError::Api(err)) => {
                tracing::warn!(err = %err, "heartbeat failed");
                TickOutcome::Failed(err.to_string())
            }
            Err(TickError::Hook(message)) => {
                tracing::warn!(err = %message, "heartbeat failed");
                TickOutcome::Failed(message)
            }
        }
    }

    async fn try_tick(&self) -> Result<(), TickError> {
        let hooks = &self.hooks;
        hooks
            .drain_timer_sync_now()
            .await
            .map_err(TickError::Hook)?;
        let timer_status = hooks.timer_status();
        if matches!(
            timer_status,
            HeartbeatTimerStatus::Running { paused: false, .. }
        ) {
            hooks.timer_liveness();
        }
        // Object-literal order in the TypeScript: observedAt is read BEFORE the
        // permission probe's await.
        let observed_at = hooks.server_aligned_now();
        let permissions = hooks.permissions().await.map_err(TickError::Hook)?;
        let body = build_heartbeat_request(HeartbeatArgs {
            agent_version: hooks.agent_version(),
            platform: self.platform,
            timer_status,
            permissions: Some(permissions),
            startup: Some(hooks.startup()),
            observed_at,
        })?;
        let started = hooks.device_now_ms();
        let options = RequestOptions::post(Some(json_body(&body)?));
        let res: HeartbeatResponse = self.api.api("/v1/agent/heartbeat", &options).await?;
        self.handle_response(&res, started);
        Ok(())
    }

    /// Everything after `lastHeartbeatAt = res.serverTime`.
    fn handle_response(&self, res: &HeartbeatResponse, started: i64) {
        let hooks = &self.hooks;
        if let Ok(mut last) = self.last_heartbeat_at.lock() {
            *last = Some(res.server_time.clone());
        }
        let previous = hooks.server_clock_offset_ms();
        let offset = hooks.note_server_time(&res.server_time, started, hooks.device_now_ms());
        if let Some(offset) = offset.filter(|o| abs(sub(*o, previous)) >= 1_000.0) {
            tracing::info!(
                offset_ms = offset,
                previous_offset_ms = previous,
                held_for_running_timer = hooks.has_deferred_clock_correction(),
                "server clock offset updated"
            );
        }
        tracing::debug!(server_time = %res.server_time, config_version = %res.config_version, "heartbeat ok");
        self.handle_disposition(res.timer.as_ref());
        if !res.config_version.is_empty() && res.config_version != hooks.config_version() {
            hooks.request_config_refresh();
        }
        hooks.request_activity_drain(DrainTrigger::Heartbeat);
    }

    fn handle_disposition(&self, timer: Option<&TimerDisposition>) {
        let Some(timer) = timer else { return };
        match timer.disposition.as_str() {
            "needs_sync" => self.hooks.request_timer_drain(DrainTrigger::Heartbeat),
            "finalized" | "conflict" => {
                tracing::warn!(
                    entry_id = %timer.entry_id,
                    disposition = %timer.disposition,
                    ended_at = ?timer.ended_at,
                    close_reason = ?timer.close_reason,
                    "server rejected active timer checkpoint"
                );
                let ended = timer.ended_at.as_deref().filter(|s| !s.is_empty());
                if let Some(DateParse::Time(ms)) = ended.map(parse) {
                    self.hooks.accept_server_finalization(&timer.entry_id, ms);
                }
            }
            _ => {}
        }
    }

    /// `sendHeartbeatNow()`.
    pub fn send_now(self: &Arc<Self>) -> JoinHandle<TickOutcome> {
        let me = Arc::clone(self);
        tokio::spawn(async move { me.tick().await })
    }

    /// `startHeartbeat()`: an immediate tick, the `auth` drains, then every 60 s.
    /// Ticks are not serialized: a slow one overlaps the next, as in TypeScript.
    pub fn start(self: &Arc<Self>) {
        let Ok(mut slot) = self.timer.lock() else {
            return;
        };
        if slot.is_some() {
            return;
        }
        drop(self.send_now());
        self.hooks.request_timer_drain(DrainTrigger::Auth);
        self.hooks.request_activity_drain(DrainTrigger::Auth);
        let me = Arc::clone(self);
        *slot = Some(tokio::spawn(async move {
            let mut every = tokio::time::interval(Duration::from_millis(HEARTBEAT_INTERVAL_MS));
            every.tick().await;
            loop {
                every.tick().await;
                drop(me.send_now());
            }
        }));
        tracing::info!(interval_ms = HEARTBEAT_INTERVAL_MS, "heartbeat started");
    }

    /// `stopHeartbeat()`.
    pub fn stop(&self) {
        if let Ok(mut slot) = self.timer.lock()
            && let Some(handle) = slot.take()
        {
            handle.abort();
            tracing::info!("heartbeat stopped");
        }
    }
}
