//! The engine on real threads. Everything else replays on `ManualExecutor`, which has one
//! thread and so can neither deadlock nor race: these tests wire the REAL runtime, hydrator and
//! drain onto a thread-per-task spawner and fail (with a timeout) instead of hanging.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    clippy::expect_used,
    reason = "tests unwrap and assert"
)]

mod timer_support;

use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Barrier, Mutex, PoisonError};
use std::task::{Context, Poll, Wake, Waker};
use std::thread;
use std::time::{Duration, Instant};

use futures_util::future::{BoxFuture, FutureExt};
use serde_json::json;
use timer_support::{Accrual, FakeClock, Gate, MemStore, RecLogger, SeqIdGen, SpySync};
use timo_core::timer::drain::{
    FlushUnsynced, TimerSyncDrain, TimerSyncDrainDeps, TimerSyncDrainReason,
};
use timo_core::timer::dto::TodayLedgerResponse;
use timo_core::timer::exec::{Spawn, TimerId, Timers};
use timo_core::timer::hydrator::{
    HydratorCache, HydratorDeps, StoredTokens, TodayLedgerHydrator, TodayLedgerRefreshReason,
};
use timo_core::timer::types::{DayWindow, StartArgs, TimerOwner, TodayLedgerMode};
use timo_core::timer::{TimerError, TimerRuntime, TimerService};

const PATIENCE: Duration = Duration::from_secs(10);

struct ThreadWaker(thread::Thread);

impl Wake for ThreadWaker {
    fn wake(self: Arc<Self>) {
        self.0.unpark();
    }
}

/// Drive a future to completion on the calling thread.
fn block_on<F: Future>(future: F) -> F::Output {
    let mut future = std::pin::pin!(future);
    let waker = Waker::from(Arc::new(ThreadWaker(thread::current())));
    let mut cx = Context::from_waker(&waker);
    loop {
        if let Poll::Ready(value) = future.as_mut().poll(&mut cx) {
            return value;
        }
        thread::park();
    }
}

/// One OS thread per spawned task: a multi-thread executor in a dozen lines.
struct ThreadSpawner;

impl Spawn for ThreadSpawner {
    fn spawn(&self, task: BoxFuture<'static, ()>) {
        thread::spawn(move || block_on(task));
    }
}

/// `setTimeout` that fires 5 ms later on its own thread (the real delay is 250 ms: what matters
/// is that it is a later turn than the pass that scheduled it); `setInterval` never fires.
struct ThreadTimers;

impl Timers for ThreadTimers {
    fn set_interval(&self, _: f64, _: Box<dyn Fn() + Send + Sync>) -> TimerId {
        TimerId(1)
    }

    fn clear_interval(&self, _: TimerId) {}

    fn set_timeout(&self, _: f64, callback: Box<dyn FnOnce() + Send>) {
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(5));
            callback();
        });
    }
}

/// Run `work` on a thread; panic, not hang, when it does not finish.
fn within<T: Send + 'static>(what: &str, work: impl FnOnce() -> T + Send + 'static) -> T {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _sent = tx.send(work());
    });
    rx.recv_timeout(PATIENCE)
        .unwrap_or_else(|_| panic!("{what} did not finish within {PATIENCE:?}: it is deadlocked"))
}

fn until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + PATIENCE;
    while !done() {
        assert!(Instant::now() < deadline, "{what} never happened");
        thread::sleep(Duration::from_millis(2));
    }
}

struct CountingCache(Arc<AtomicUsize>);

impl HydratorCache for CountingCache {
    fn replace_snapshot(
        &self,
        _: &TimerOwner,
        _: DayWindow,
        _: &TodayLedgerResponse,
    ) -> Result<(), String> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

/// The real hydrator over the real runtime, with every dependency already ready.
fn hydrator_over(
    runtime: &Arc<TimerRuntime>,
    snapshots: &Arc<AtomicUsize>,
) -> Arc<TodayLedgerHydrator> {
    TodayLedgerHydrator::new(HydratorDeps {
        timer: Arc::new(Arc::clone(runtime)),
        cache: Arc::new(CountingCache(Arc::clone(snapshots))),
        get_mode: Box::new(|| TodayLedgerMode::Visible),
        load_tokens: Box::new(|| {
            async {
                Some(StoredTokens {
                    user_id: "test-user".into(),
                    workspace_id: "test-workspace".into(),
                })
            }
            .boxed()
        }),
        get_window: Box::new(|| {
            Some(DayWindow {
                start: 0.0,
                end: 86_400_000.0,
            })
        }),
        fetch_snapshot: Box::new(|_| {
            async {
                Ok(json!({
                    "complete": true, "serverTime": "1970-01-01T00:00:01.000Z",
                    "workspaceTimezone": "Asia/Kolkata", "entries": [], "effectiveEntries": []
                }))
            }
            .boxed()
        }),
        on_updated: Box::new(|| {}),
        log: Arc::new(RecLogger::default()),
        timers: Arc::new(ThreadTimers),
        spawner: Arc::new(ThreadSpawner),
    })
}

fn runtime() -> Arc<TimerRuntime> {
    let service = TimerService::new(
        Box::new(MemStore::new()),
        Arc::new(FakeClock::new(timer_support::T0)),
        Box::new(SeqIdGen::default()),
    );
    TimerRuntime::new(
        service,
        Box::new(Accrual::default()),
        Box::new(SpySync::new()),
        Arc::new(ThreadSpawner),
    )
}

/// Finding 2: the mutation listener ran while the runtime held its service lock. Wired to
/// the hydrator, whose first poll runs eagerly, with a token loader that is already ready, it
/// reached `current_owner()`, which takes the same mutex.
#[test]
fn a_mutation_listener_that_hydrates_never_deadlocks_the_runtime() {
    let runtime = runtime();
    let snapshots = Arc::new(AtomicUsize::new(0));
    let hydrator = hydrator_over(&runtime, &snapshots);
    runtime.lock().set_mutation_listener(Some(Arc::new({
        let hydrator = Arc::clone(&hydrator);
        move || {
            let _running = hydrator.refresh(TodayLedgerRefreshReason::Mutation);
        }
    })));
    let started = within("start()", {
        let runtime = Arc::clone(&runtime);
        move || {
            block_on(async move {
                runtime
                    .start(StartArgs {
                        lark_task_guid: Some("task".into()),
                    })
                    .await
            })
        }
    });
    assert!(started.is_ok(), "{started:?}");
    until("the hydration the mutation asked for", || {
        snapshots.load(Ordering::SeqCst) == 1
    });
    // And the engine is still usable afterwards, from another thread.
    let stopped = within("stop()", move || {
        block_on(async move { runtime.stop().await })
    });
    assert!(stopped.is_ok(), "{stopped:?}");
}

/// A `flushUnsynced` that answers each call from a script and records how many are running.
struct ScriptedFlush {
    calls: AtomicUsize,
    running: AtomicUsize,
    most_running: AtomicUsize,
    more_after: usize,
    hold: Mutex<Option<Gate>>,
}

struct Flush(Arc<ScriptedFlush>);

impl FlushUnsynced for Flush {
    fn flush_unsynced(&self) -> BoxFuture<'static, Result<bool, TimerError>> {
        let this = Arc::clone(&self.0);
        let call = this.calls.fetch_add(1, Ordering::SeqCst) + 1;
        let now_running = this.running.fetch_add(1, Ordering::SeqCst) + 1;
        this.most_running.fetch_max(now_running, Ordering::SeqCst);
        let hold = this
            .hold
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        async move {
            if let Some(gate) = hold {
                // The first pass is held until the test lets go of it.
                gate.wait().await;
            }
            this.running.fetch_sub(1, Ordering::SeqCst);
            Ok(call < this.more_after)
        }
        .boxed()
    }
}

fn drain_over(flush: &Arc<ScriptedFlush>) -> Arc<TimerSyncDrain> {
    TimerSyncDrain::new(TimerSyncDrainDeps {
        timer: Box::new(Flush(Arc::clone(flush))),
        is_online: None,
        interval_ms: None,
        timers: Arc::new(ThreadTimers),
        spawner: Arc::new(ThreadSpawner),
        logger: None,
    })
}

fn scripted(more_after: usize, hold: Option<Gate>) -> Arc<ScriptedFlush> {
    Arc::new(ScriptedFlush {
        calls: AtomicUsize::new(0),
        running: AtomicUsize::new(0),
        most_running: AtomicUsize::new(0),
        more_after,
        hold: Mutex::new(hold),
    })
}

/// Finding 3: `drainNow` is single flight. The check of `inFlight` and the install of the new
/// flight were two lock acquisitions, so callers on two threads could both start a flush, and
/// the first to finish cleared the other's slot.
#[test]
fn concurrent_drain_triggers_start_exactly_one_flush_and_share_its_future() {
    const THREADS: usize = 12;
    for round in 0..150 {
        let release = Gate::default();
        let flush = scripted(1, Some(release.clone()));
        let drain = drain_over(&flush);
        let barrier = Arc::new(Barrier::new(THREADS));
        let handles: Vec<_> = (0..THREADS)
            .map(|i| {
                let (drain, barrier) = (Arc::clone(&drain), Arc::clone(&barrier));
                thread::spawn(move || {
                    barrier.wait();
                    let reason = [TimerSyncDrainReason::Manual, TimerSyncDrainReason::Wake][i % 2];
                    drain.drain_now(reason, 1)
                })
            })
            .collect();
        let futures: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(
            flush.calls.load(Ordering::SeqCst),
            1,
            "round {round}: more than one flush started"
        );
        assert!(
            futures.iter().all(|f| f.ptr_eq(&futures[0])),
            "round {round}: the callers did not share one future"
        );
        release.open();
        within("the shared drain", move || block_on(futures[0].clone()));
        assert_eq!(
            flush.most_running.load(Ordering::SeqCst),
            1,
            "round {round}"
        );
    }
}

/// Finding 3, the chain: each pass that reports a backlog schedules the next from its own
/// completion, one flush at a time, and the slot a finished pass clears is its own.
#[test]
fn chained_passes_run_one_at_a_time_and_each_clears_only_its_own_slot() {
    let flush = scripted(4, None);
    let drain = drain_over(&flush);
    let first = drain.drain_now(TimerSyncDrainReason::Boot, 1);
    // Racing triggers while the chain runs must join it, never start a second flush beside it.
    let hammer: Vec<_> = (0..4)
        .map(|_| {
            let drain = Arc::clone(&drain);
            thread::spawn(move || {
                for _ in 0..200 {
                    let _joined = drain.drain_now(TimerSyncDrainReason::Wake, 1);
                    thread::yield_now();
                }
            })
        })
        .collect();
    within("the first pass", move || block_on(first));
    for handle in hammer {
        handle.join().unwrap();
    }
    until("the chain to finish", || {
        flush.calls.load(Ordering::SeqCst) >= 4
    });
    thread::sleep(Duration::from_millis(100));
    assert_eq!(
        flush.most_running.load(Ordering::SeqCst),
        1,
        "two flushes ran at once"
    );
}
