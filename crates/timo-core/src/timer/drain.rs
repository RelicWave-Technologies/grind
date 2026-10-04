//! The 60 s timer-sync drain.
//!
//! Port of `legacy/agent/src/main/services/timer/syncDrain.ts`. Timers and the
//! executor are injected (the TypeScript injects `setInterval`/`clearInterval`
//! and reaches for the global `setTimeout` for the chained pass; here that one
//! is injectable too, so a test can drive it).

use std::sync::{Arc, Mutex, PoisonError};

use futures_util::future::{BoxFuture, FutureExt};

use super::error::TimerError;
use super::exec::{
    EngineLogger, LogValue, SharedFuture, Spawn, TimerId, Timers, completed, spawn_eager,
};
use super::runtime::TimerRuntime;

/// `DEFAULT_TIMER_SYNC_DRAIN_INTERVAL_MS`.
pub const DEFAULT_TIMER_SYNC_DRAIN_INTERVAL_MS: f64 = 60_000.0;
/// `MAX_CHAINED_DRAIN_PASSES`: the cap that turns a hot loop into a slow retry.
pub const MAX_CHAINED_DRAIN_PASSES: u32 = 20;
/// `CHAINED_DRAIN_DELAY_MS`: chained passes wait a beat.
pub const CHAINED_DRAIN_DELAY_MS: f64 = 250.0;

/// `TimerSyncDrainReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimerSyncDrainReason {
    Interval,
    Auth,
    Heartbeat,
    Wake,
    Manual,
    Boot,
}

impl TimerSyncDrainReason {
    /// The TypeScript string literal.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Interval => "interval",
            Self::Auth => "auth",
            Self::Heartbeat => "heartbeat",
            Self::Wake => "wake",
            Self::Manual => "manual",
            Self::Boot => "boot",
        }
    }
}

/// `Pick<TimerService, 'flushUnsynced'>`: resolves `true` when a pass stopped
/// at its batch limit with entries remaining.
pub trait FlushUnsynced: Send + Sync {
    fn flush_unsynced(&self) -> BoxFuture<'static, Result<bool, TimerError>>;
}

impl FlushUnsynced for Arc<TimerRuntime> {
    fn flush_unsynced(&self) -> BoxFuture<'static, Result<bool, TimerError>> {
        let runtime = Arc::clone(self);
        async move { runtime.flush_unsynced_default().await }.boxed()
    }
}

/// `isOnline?: () => boolean`; `None` stands for the probe throwing.
pub type IsOnline = Box<dyn Fn() -> Option<bool> + Send + Sync>;

/// `TimerSyncDrainDeps`.
pub struct TimerSyncDrainDeps {
    pub timer: Box<dyn FlushUnsynced>,
    pub is_online: Option<IsOnline>,
    pub interval_ms: Option<f64>,
    pub timers: Arc<dyn Timers>,
    pub spawner: Arc<dyn Spawn>,
    pub logger: Option<Arc<dyn EngineLogger>>,
}

impl std::fmt::Debug for TimerSyncDrainDeps {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TimerSyncDrainDeps").finish_non_exhaustive()
    }
}

/// `inFlight`: the pass that holds the slot, with the number it was issued so that a pass
/// that finishes clears its own slot and never a later pass's.
struct Flight {
    id: u64,
    future: SharedFuture,
}

#[derive(Default)]
struct State {
    interval: Option<TimerId>,
    in_flight: Option<Flight>,
    issued: u64,
}

/// Port of `TimerSyncDrain`.
pub struct TimerSyncDrain {
    deps: TimerSyncDrainDeps,
    interval_ms: f64,
    state: Mutex<State>,
}

impl std::fmt::Debug for TimerSyncDrain {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TimerSyncDrain").finish_non_exhaustive()
    }
}

impl TimerSyncDrain {
    #[must_use]
    pub fn new(deps: TimerSyncDrainDeps) -> Arc<Self> {
        let interval_ms = deps
            .interval_ms
            .unwrap_or(DEFAULT_TIMER_SYNC_DRAIN_INTERVAL_MS);
        Arc::new(Self {
            deps,
            interval_ms,
            state: Mutex::new(State::default()),
        })
    }

    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn debug(&self, message: &str, meta: &[(&str, LogValue)]) {
        if let Some(logger) = &self.deps.logger {
            logger.debug(message, meta);
        }
    }

    fn warn(&self, message: &str, meta: &[(&str, LogValue)]) {
        if let Some(logger) = &self.deps.logger {
            logger.warn(message, meta);
        }
    }

    /// Port of `TimerSyncDrain.start`.
    pub fn start(self: &Arc<Self>) {
        let mut state = self.state();
        if state.interval.is_some() {
            return;
        }
        let this = Arc::clone(self);
        let id = self.deps.timers.set_interval(
            self.interval_ms,
            Box::new(move || {
                let _running = this.drain_now(TimerSyncDrainReason::Interval, 1);
            }),
        );
        state.interval = Some(id);
        drop(state);
        self.debug(
            "timer sync drain started",
            &[("intervalMs", LogValue::Number(self.interval_ms))],
        );
    }

    /// Port of `TimerSyncDrain.stop`.
    pub fn stop(&self) {
        let Some(id) = self.state().interval.take() else {
            return;
        };
        self.deps.timers.clear_interval(id);
        self.debug("timer sync drain stopped", &[]);
    }

    /// Port of `TimerSyncDrain.drainNow`. Single-flight: a concurrent caller,
    /// whatever its reason, gets the in-flight future itself.
    ///
    /// JavaScript checks `inFlight` and installs the new pass in one synchronous stretch.
    /// Here that is one lock acquisition: the slot is reserved with the pass's future before
    /// the lock is released, and the pass is only started (`spawn_eager`, which makes its
    /// first poll, where `flushUnsynced` is called) after it is released.
    pub fn drain_now(self: &Arc<Self>, reason: TimerSyncDrainReason, pass: u32) -> SharedFuture {
        let reason_meta = || ("reason", LogValue::Text(reason.as_str().to_owned()));
        if reason == TimerSyncDrainReason::Interval && self.is_definitely_offline() {
            self.debug("timer sync drain skipped offline", &[reason_meta()]);
            return completed();
        }
        let (shared, joined) = {
            let mut state = self.state();
            if let Some(flight) = &state.in_flight {
                (flight.future.clone(), true)
            } else {
                state.issued += 1;
                let id = state.issued;
                let shared = Arc::clone(self).pass(id, reason, pass).boxed().shared();
                state.in_flight = Some(Flight {
                    id,
                    future: shared.clone(),
                });
                (shared, false)
            }
        };
        if joined {
            self.debug("timer sync drain already running", &[reason_meta()]);
        } else {
            spawn_eager(self.deps.spawner.as_ref(), &shared);
        }
        shared
    }

    /// One pass: `flushUnsynced().then(...).catch(...).finally(clear)`.
    async fn pass(self: Arc<Self>, id: u64, reason: TimerSyncDrainReason, pass: u32) {
        let outcome = self.deps.timer.flush_unsynced().await;
        self.finish_pass(outcome, reason, pass);
        let mut state = self.state();
        if state
            .in_flight
            .as_ref()
            .is_some_and(|flight| flight.id == id)
        {
            state.in_flight = None;
        }
    }

    /// The `.then(...).catch(...)` of one pass.
    fn finish_pass(
        self: &Arc<Self>,
        outcome: Result<bool, TimerError>,
        reason: TimerSyncDrainReason,
        pass: u32,
    ) {
        let reason_meta = ("reason", LogValue::Text(reason.as_str().to_owned()));
        let more_remaining = match outcome {
            Ok(more) => more,
            Err(err) => {
                self.warn(
                    "timer sync drain failed",
                    &[reason_meta, ("err", LogValue::Text(err.to_string()))],
                );
                return;
            }
        };
        self.debug(
            "timer sync drain finished",
            &[
                reason_meta.clone(),
                ("moreRemaining", LogValue::Bool(more_remaining)),
            ],
        );
        if !more_remaining {
            return;
        }
        if pass >= MAX_CHAINED_DRAIN_PASSES {
            self.warn(
                "timer sync drain still reports a backlog; leaving it to the interval",
                &[reason_meta, ("passes", LogValue::Number(f64::from(pass)))],
            );
            return;
        }
        let this = Arc::clone(self);
        self.deps.timers.set_timeout(
            CHAINED_DRAIN_DELAY_MS,
            Box::new(move || {
                let _running = this.drain_now(reason, pass + 1);
            }),
        );
    }

    fn is_definitely_offline(&self) -> bool {
        self.deps
            .is_online
            .as_ref()
            .is_some_and(|probe| probe() == Some(false))
    }
}
