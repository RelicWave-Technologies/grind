//! Drains the local activity outbox even when no new minute arrives. Port of
//! `legacy/agent/src/main/services/activity/syncDrain.ts` (SC-68).

use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::FutureExt;
use futures_util::future::{BoxFuture, Shared};
use tokio::task::JoinHandle;

pub const DEFAULT_ACTIVITY_SYNC_DRAIN_INTERVAL_MS: u64 = 5 * 60_000;
pub const HEARTBEAT_ACTIVITY_DRAIN_THROTTLE_MS: i64 = 60_000;
pub const ACTIVITY_SYNC_DRAIN_MAX_BATCHES: usize = 10;

/// `ActivitySyncDrainReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActivityDrainReason {
    Boot,
    Auth,
    Heartbeat,
    Wake,
    Periodic,
    Sample,
    Manual,
}

/// `ActivitySyncDrainResult.skipped`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skipped {
    HeartbeatThrottle,
}

/// `ActivitySyncDrainResult`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct DrainResult {
    pub batches: usize,
    pub samples: usize,
    pub skipped: Option<Skipped>,
}

/// `ActivitySyncDrainDeps` minus the timers (tokio's, so tests pause the clock).
pub trait ActivityDrainDeps: Send + Sync + 'static {
    /// `beforeFlush`: the timer sync that must land first (parents must exist).
    fn before_flush(&self) -> impl Future<Output = Result<(), String>> + Send {
        async { Ok(()) }
    }
    /// `flush(getStore())`: the number of rows synced.
    fn flush(&self) -> impl Future<Output = Result<usize, String>> + Send;
    /// `now` (device `Date.now`).
    fn now_ms(&self) -> i64;
}

/// Interval, throttle and batch cap (defaults as in the TypeScript).
#[derive(Debug, Clone, Copy)]
pub struct DrainConfig {
    pub interval_ms: u64,
    pub heartbeat_throttle_ms: i64,
    pub max_batches: usize,
}

impl Default for DrainConfig {
    fn default() -> Self {
        Self {
            interval_ms: DEFAULT_ACTIVITY_SYNC_DRAIN_INTERVAL_MS,
            heartbeat_throttle_ms: HEARTBEAT_ACTIVITY_DRAIN_THROTTLE_MS,
            max_batches: ACTIVITY_SYNC_DRAIN_MAX_BATCHES,
        }
    }
}

/// The promise `drainNow` returns: concurrent callers get the SAME one.
pub type DrainHandle = Shared<BoxFuture<'static, DrainResult>>;

#[derive(Default)]
struct State {
    timer: Option<JoinHandle<()>>,
    in_flight: Option<DrainHandle>,
    last_heartbeat_drain_at: i64,
}

pub struct ActivitySyncDrain<D: ActivityDrainDeps> {
    deps: Arc<D>,
    config: DrainConfig,
    state: Mutex<State>,
}

impl<D: ActivityDrainDeps> std::fmt::Debug for ActivitySyncDrain<D> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ActivitySyncDrain").finish_non_exhaustive()
    }
}

impl<D: ActivityDrainDeps> ActivitySyncDrain<D> {
    pub fn new(deps: Arc<D>, config: DrainConfig) -> Arc<Self> {
        Arc::new(Self {
            deps,
            config,
            state: Mutex::new(State::default()),
        })
    }

    /// `start()`: a periodic drain, first fired one interval from now.
    pub fn start(self: &Arc<Self>) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.timer.is_some() {
            return;
        }
        let me = Arc::clone(self);
        let every = Duration::from_millis(self.config.interval_ms);
        state.timer = Some(tokio::spawn(async move {
            let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
            loop {
                tick.tick().await;
                drop(me.drain_now(ActivityDrainReason::Periodic));
            }
        }));
        tracing::debug!(
            interval_ms = self.config.interval_ms,
            "activity sync drain started"
        );
    }

    /// `stop()`.
    pub fn stop(&self) {
        if let Ok(mut state) = self.state.lock()
            && let Some(timer) = state.timer.take()
        {
            timer.abort();
            tracing::debug!("activity sync drain stopped");
        }
    }

    /// `drainNow(reason)`. A heartbeat-triggered drain is throttled to one per
    /// `heartbeat_throttle_ms`; a drain already running is shared, not doubled.
    /// The work starts at once (a spawned task), as a JavaScript promise does.
    pub fn drain_now(self: &Arc<Self>, reason: ActivityDrainReason) -> DrainHandle {
        let Ok(mut state) = self.state.lock() else {
            return ready(DrainResult::default());
        };
        if reason == ActivityDrainReason::Heartbeat {
            let now = self.deps.now_ms();
            if now.saturating_sub(state.last_heartbeat_drain_at) < self.config.heartbeat_throttle_ms
            {
                tracing::debug!("activity sync drain heartbeat throttled");
                return ready(DrainResult {
                    skipped: Some(Skipped::HeartbeatThrottle),
                    ..DrainResult::default()
                });
            }
            state.last_heartbeat_drain_at = now;
        }
        if let Some(running) = &state.in_flight {
            tracing::debug!("activity sync drain already running");
            return running.clone();
        }
        let me = Arc::clone(self);
        let task = tokio::spawn(async move {
            let result = me.run().await;
            if let Ok(mut state) = me.state.lock() {
                state.in_flight = None;
            }
            result
        });
        let handle: DrainHandle = task.map(Result::unwrap_or_default).boxed().shared();
        state.in_flight = Some(handle.clone());
        handle
    }

    async fn run(&self) -> DrainResult {
        let mut result = DrainResult::default();
        if let Err(err) = self.deps.before_flush().await {
            tracing::warn!(err = %err, "activity sync prerequisite failed");
            return result;
        }
        for _ in 0..self.config.max_batches {
            match self.deps.flush().await {
                Ok(flushed) if flushed > 0 => {
                    result.batches += 1;
                    result.samples += flushed;
                }
                Ok(_) => break,
                Err(err) => {
                    tracing::warn!(err = %err, batches = result.batches, "activity sync drain failed");
                    break;
                }
            }
        }
        tracing::debug!(
            batches = result.batches,
            samples = result.samples,
            "activity sync drain finished"
        );
        result
    }
}

fn ready(result: DrainResult) -> DrainHandle {
    futures_util::future::ready(result).boxed().shared()
}
