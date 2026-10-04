//! Shared fakes for the ported timer tests: the Rust twins of the helpers at the
//! top of `timerService.test.ts` (`FakeClock`, `SeqIdGen`, `MemStore`, `SpySync`).
#![allow(
    dead_code,
    clippy::float_arithmetic,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    reason = "each test crate uses a subset of these helpers; the fakes do the same float maths as the TypeScript"
)]

pub mod mem_store;
pub mod spy_sync;

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use futures_util::future::{BoxFuture, FutureExt};
use timo_core::timer::error::GuardError;
use timo_core::timer::executor::ManualExecutor;
use timo_core::timer::traits::{Clock, IdGen, TrackingAccrualGuard};
use timo_core::timer::types::{BlockingCapability, CapabilityState, TrackingReadiness};
use timo_core::timer::{TimerRuntime, TimerService};

pub use mem_store::MemStore;
pub use spy_sync::SpySync;

pub const T0: f64 = 1_700_000_000_000.0;
pub const MIN: f64 = 60_000.0;

/// `FakeClock`: a settable instant.
#[derive(Clone)]
pub struct FakeClock(Arc<Mutex<f64>>);

impl FakeClock {
    pub fn new(t: f64) -> Self {
        Self(Arc::new(Mutex::new(t)))
    }

    pub fn advance(&self, ms: f64) {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner) += ms;
    }

    pub fn t(&self) -> f64 {
        *self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

impl Clock for FakeClock {
    fn now(&self) -> f64 {
        self.t()
    }
}

/// `SeqIdGen`: `id_000001`, `id_000002`, ...
#[derive(Clone, Default)]
pub struct SeqIdGen(Arc<Mutex<u32>>);

impl IdGen for SeqIdGen {
    fn ulid(&mut self) -> String {
        let mut n = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        *n += 1;
        format!("id_{:06}", *n)
    }
}

/// `allowAccrual`: allows unless `blocked` is set (`shouldBlockAccrual`).
#[derive(Clone, Default)]
pub struct Accrual(pub Arc<AtomicBool>);

impl Accrual {
    pub fn block(&self, on: bool) {
        self.0.store(on, Ordering::SeqCst);
    }
}

impl TrackingAccrualGuard for Accrual {
    fn assert_can_accrue(&self) -> BoxFuture<'_, Result<(), GuardError>> {
        let blocked = self.0.load(Ordering::SeqCst);
        async move {
            if blocked {
                return Err(GuardError::Blocked(Box::new(TrackingReadiness {
                    ready: false,
                    checked_at: "2023-11-14T22:13:20.000Z".to_owned(),
                    screen_recording: CapabilityState::NeedsSettings,
                    accessibility: CapabilityState::Ready,
                    blocking_capabilities: vec![BlockingCapability::ScreenRecording],
                })));
            }
            Ok(())
        }
        .boxed()
    }
}

/// Everything `beforeEach` builds, plus the executor that stands in for the
/// microtask queue.
pub struct Fixture {
    pub clock: FakeClock,
    pub ids: SeqIdGen,
    pub store: MemStore,
    pub sync: SpySync,
    pub accrual: Accrual,
    pub exec: ManualExecutor,
    pub svc: Arc<TimerRuntime>,
}

impl Fixture {
    pub fn new() -> Self {
        Self::with_clock(FakeClock::new(T0))
    }

    /// The same fixture over a clock starting somewhere else.
    pub fn with_clock(clock: FakeClock) -> Self {
        let sync = SpySync::new();
        let mut fixture = Self {
            clock,
            ids: SeqIdGen::default(),
            store: MemStore::new(),
            sync: sync.clone(),
            accrual: Accrual::default(),
            exec: ManualExecutor::new(),
            // Replaced just below: the runtime needs the other fields.
            svc: TimerRuntime::new(
                TimerService::new(
                    Box::new(MemStore::new()),
                    Arc::new(FakeClock::new(0.0)),
                    Box::new(SeqIdGen::default()),
                ),
                Box::new(Accrual::default()),
                Box::new(SpySync::new()),
                Arc::new(ManualExecutor::new()),
            ),
        };
        fixture.svc = fixture.runtime_with(sync, None);
        fixture
    }

    /// `new TimerService(store, sync, clock, ids, allowAccrual)` over this fixture's
    /// fakes, with `sync` and an optional sixth/seventh constructor argument.
    pub fn runtime_with(
        &self,
        sync: impl timo_core::timer::traits::SyncClient + 'static,
        configure: Option<Box<dyn FnOnce(TimerService) -> TimerService>>,
    ) -> Arc<TimerRuntime> {
        let mut service = TimerService::new(
            Box::new(self.store.clone()),
            Arc::new(self.clock.clone()),
            Box::new(self.ids.clone()),
        );
        if let Some(configure) = configure {
            service = configure(service);
        }
        TimerRuntime::new(
            service,
            Box::new(self.accrual.clone()),
            Box::new(sync),
            Arc::new(self.exec.clone()),
        )
    }

    /// A second service over the same store, sync, clock and ids (a "reboot").
    pub fn reboot(&self) -> Arc<TimerRuntime> {
        self.runtime_with(self.sync.clone(), None)
    }

    /// `await fut`: run it, and everything it wakes, until it completes.
    pub fn run<F: Future + Send + 'static>(&self, fut: F) -> F::Output
    where
        F::Output: Send + 'static,
    {
        run_on(&self.exec, fut)
    }

    /// Let queued background work run (a microtask checkpoint).
    pub fn pump(&self) {
        self.exec.run_until_stalled();
    }
}

/// `await fut` on `exec`.
pub fn run_on<F: Future + Send + 'static>(exec: &ManualExecutor, fut: F) -> F::Output
where
    F::Output: Send + 'static,
{
    use timo_core::timer::exec::Spawn;
    let slot: Arc<Mutex<Option<F::Output>>> = Arc::new(Mutex::new(None));
    let out = Arc::clone(&slot);
    exec.spawn(
        async move {
            let value = fut.await;
            *out.lock().unwrap_or_else(PoisonError::into_inner) = Some(value);
        }
        .boxed(),
    );
    exec.run_until_stalled();
    let value = slot.lock().unwrap_or_else(PoisonError::into_inner).take();
    value.expect(
        "the awaited future never completed (it is waiting on something that is never delivered)",
    )
}

/// `.rejects.toMatchObject({ code: 'TRACKING_PERMISSIONS_REQUIRED' })`.
pub fn is_blocked(error: &timo_core::timer::TimerError) -> bool {
    matches!(error, timo_core::timer::TimerError::Guard(g) if g.code() == Some("TRACKING_PERMISSIONS_REQUIRED"))
}

use timo_core::timer::TimerError;
use timo_core::timer::types::{StartArgs, TimerAwayReason, TimerExitReason, TimerStatus};

/// The fields `expect(status).toMatchObject(...)` reads off a RUNNING status.
#[derive(Debug, Clone)]
pub struct Running {
    pub entry_id: String,
    pub revision: f64,
    pub guid: Option<String>,
    pub started_at: f64,
    pub segment_started_at: Option<f64>,
    pub worked_ms: f64,
    pub paused: bool,
    pub pause_reason: Option<timo_core::TimeEntryPauseReason>,
}

/// A RUNNING status, or a panic naming what it was instead.
pub fn running(status: &TimerStatus) -> Running {
    match status {
        TimerStatus::Running {
            entry_id,
            revision,
            lark_task_guid,
            started_at,
            segment_started_at,
            worked_ms,
            paused,
            pause_reason,
        } => Running {
            entry_id: entry_id.clone(),
            revision: *revision,
            guid: lark_task_guid.clone(),
            started_at: *started_at,
            segment_started_at: *segment_started_at,
            worked_ms: *worked_ms,
            paused: *paused,
            pause_reason: *pause_reason,
        },
        idle @ TimerStatus::Idle { .. } => panic!("expected a RUNNING timer, got {idle:?}"),
    }
}

pub fn is_idle(status: &TimerStatus) -> bool {
    matches!(status, TimerStatus::Idle { .. })
}

impl Fixture {
    pub fn start(&self, guid: Option<&str>) -> Result<TimerStatus, TimerError> {
        let svc = self.svc.clone();
        let args = StartArgs {
            lark_task_guid: guid.map(str::to_owned),
        };
        self.run(async move { svc.start(args).await })
    }

    pub fn start_ok(&self, guid: Option<&str>) -> TimerStatus {
        self.start(guid).unwrap()
    }

    pub fn stop(&self) -> Result<TimerStatus, TimerError> {
        let svc = self.svc.clone();
        self.run(async move { svc.stop().await })
    }

    pub fn pause(&self) -> Result<TimerStatus, TimerError> {
        let svc = self.svc.clone();
        self.run(async move { svc.pause().await })
    }

    pub fn resume(&self) -> Result<TimerStatus, TimerError> {
        let svc = self.svc.clone();
        self.run(async move { svc.resume().await })
    }

    pub fn resume_from_idle(&self, at: f64) -> Result<(), TimerError> {
        let svc = self.svc.clone();
        self.run(async move { svc.resume_from_idle(at).await })
    }

    pub fn pause_for_idle(&self, ms: f64) -> Result<(), TimerError> {
        let svc = self.svc.clone();
        self.run(async move { svc.pause_for_idle(ms).await })
    }

    pub fn pause_for_permission(&self, ms: f64) -> Result<TimerStatus, TimerError> {
        let svc = self.svc.clone();
        self.run(async move { svc.pause_for_permission(ms).await })
    }

    pub fn prepare_for_quit(&self, reason: TimerExitReason) -> Result<TimerStatus, TimerError> {
        let svc = self.svc.clone();
        self.run(async move { svc.prepare_for_quit(reason).await })
    }

    pub fn prepare_for_away(
        &self,
        reason: TimerAwayReason,
        ms: f64,
    ) -> Result<TimerStatus, TimerError> {
        let svc = self.svc.clone();
        self.run(async move { svc.prepare_for_away(reason, ms) })
    }

    pub fn flush(&self, limit: f64) -> Result<bool, TimerError> {
        let svc = self.svc.clone();
        self.run(async move { svc.flush_unsynced(limit).await })
    }

    pub fn status(&self) -> TimerStatus {
        self.svc.status().unwrap()
    }
}

/// A one-shot gate: `wait()` pends until `open()`.
#[derive(Clone, Default)]
pub struct Gate(Arc<Mutex<(bool, Option<std::task::Waker>)>>);

impl Gate {
    pub fn open(&self) {
        let mut g = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        g.0 = true;
        if let Some(w) = g.1.take() {
            w.wake();
        }
    }

    pub fn wait(&self) -> impl Future<Output = ()> + Send + 'static {
        let inner = Arc::clone(&self.0);
        std::future::poll_fn(move |cx| {
            let mut g = inner.lock().unwrap_or_else(PoisonError::into_inner);
            if g.0 {
                std::task::Poll::Ready(())
            } else {
                g.1 = Some(cx.waker().clone());
                std::task::Poll::Pending
            }
        })
    }
}

use std::collections::BTreeMap;

use timo_core::timer::exec::{EngineLogger, LogValue, TimerId, Timers};

/// A recorded log line.
#[derive(Debug, Clone, PartialEq)]
pub struct LogLine {
    pub level: &'static str,
    pub message: String,
    pub meta: Vec<(String, LogValue)>,
}

/// `{ debug: vi.fn(), warn: vi.fn() }`.
#[derive(Clone, Default)]
pub struct RecLogger(pub Arc<Mutex<Vec<LogLine>>>);

impl RecLogger {
    pub fn lines(&self, level: &str) -> Vec<LogLine> {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .iter()
            .filter(|l| l.level == level)
            .cloned()
            .collect()
    }

    fn push(&self, level: &'static str, message: &str, meta: &[(&str, LogValue)]) {
        self.0
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push(LogLine {
                level,
                message: message.to_owned(),
                meta: meta
                    .iter()
                    .map(|(k, v)| ((*k).to_owned(), v.clone()))
                    .collect(),
            });
    }
}

impl EngineLogger for RecLogger {
    fn debug(&self, message: &str, meta: &[(&str, LogValue)]) {
        self.push("debug", message, meta);
    }

    fn warn(&self, message: &str, meta: &[(&str, LogValue)]) {
        self.push("warn", message, meta);
    }
}

type Callback = Arc<dyn Fn() + Send + Sync>;

struct Timer {
    due: f64,
    interval: Option<f64>,
    callback: Callback,
}

#[derive(Default)]
struct TimersState {
    now: f64,
    next_id: u64,
    timers: BTreeMap<u64, Timer>,
}

/// `vi.useFakeTimers()`: timers fire only when the test advances time.
#[derive(Clone)]
pub struct FakeTimers {
    state: Arc<Mutex<TimersState>>,
    exec: ManualExecutor,
}

impl FakeTimers {
    pub fn new(exec: &ManualExecutor) -> Self {
        Self {
            state: Arc::new(Mutex::new(TimersState::default())),
            exec: exec.clone(),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, TimersState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The earliest timer due at or before `limit`, as (id, due, callback); one-shot timers are removed.
    fn take_next(&self, limit: f64) -> Option<(f64, Callback)> {
        let mut s = self.state();
        let (id, due) = s
            .timers
            .iter()
            .map(|(id, t)| (*id, t.due))
            .filter(|(_, due)| *due <= limit)
            .min_by(|a, b| a.1.total_cmp(&b.1))?;
        s.now = s.now.max(due);
        let timer = s.timers.get_mut(&id)?;
        let callback = Arc::clone(&timer.callback);
        match timer.interval {
            Some(every) => timer.due += every,
            None => {
                s.timers.remove(&id);
            }
        }
        Some((due, callback))
    }

    /// `vi.advanceTimersByTimeAsync(ms)`.
    pub fn advance_by(&self, ms: f64) {
        let limit = self.state().now + ms;
        self.exec.run_until_stalled();
        while let Some((_due, callback)) = self.take_next(limit) {
            callback();
            self.exec.run_until_stalled();
        }
        self.state().now = limit;
    }

    /// `vi.runAllTimersAsync()`.
    pub fn run_all(&self) {
        self.exec.run_until_stalled();
        for _ in 0..10_000 {
            let Some((_due, callback)) = self.take_next(f64::INFINITY) else {
                return;
            };
            callback();
            self.exec.run_until_stalled();
        }
    }

    pub fn pending(&self) -> usize {
        self.state().timers.len()
    }
}

impl Timers for FakeTimers {
    fn set_interval(&self, interval_ms: f64, callback: Box<dyn Fn() + Send + Sync>) -> TimerId {
        let mut s = self.state();
        s.next_id += 1;
        let (id, due) = (s.next_id, s.now + interval_ms);
        s.timers.insert(
            id,
            Timer {
                due,
                interval: Some(interval_ms),
                callback: Arc::from(callback),
            },
        );
        TimerId(id)
    }

    fn clear_interval(&self, id: TimerId) {
        self.state().timers.remove(&id.0);
    }

    fn set_timeout(&self, delay_ms: f64, callback: Box<dyn FnOnce() + Send>) {
        let cell = Mutex::new(Some(callback));
        let mut s = self.state();
        s.next_id += 1;
        let (id, due) = (s.next_id, s.now + delay_ms);
        s.timers.insert(
            id,
            Timer {
                due,
                interval: None,
                callback: Arc::new(move || {
                    if let Some(f) = cell.lock().unwrap_or_else(PoisonError::into_inner).take() {
                        f();
                    }
                }),
            },
        );
    }
}
