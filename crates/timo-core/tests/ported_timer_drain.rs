//! 1:1 port of `legacy/agent/src/main/services/timer/syncDrain.test.ts`.
#![allow(clippy::unwrap_used, reason = "tests unwrap")]

mod timer_support;

use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};

use futures_util::future::{BoxFuture, FutureExt};
use timer_support::{FakeTimers, Gate, RecLogger, run_on};
use timo_core::timer::TimerError;
use timo_core::timer::drain::{
    FlushUnsynced, MAX_CHAINED_DRAIN_PASSES, TimerSyncDrain, TimerSyncDrainDeps,
    TimerSyncDrainReason,
};
use timo_core::timer::exec::LogValue;
use timo_core::timer::executor::ManualExecutor;

/// One scripted answer of `flushUnsynced`.
enum Answer {
    Resolve(bool),
    Reject(&'static str),
    Pending(Gate),
}

/// `vi.fn().mockResolvedValue(...)` / `.mockRejectedValueOnce(...)` / `.mockReturnValue(promise)`.
struct MockFlush {
    calls: AtomicUsize,
    once: Mutex<VecDeque<Answer>>,
    default: Mutex<Option<bool>>,
}

impl MockFlush {
    fn new(once: Vec<Answer>, default: Option<bool>) -> Arc<Self> {
        Arc::new(Self {
            calls: AtomicUsize::new(0),
            once: Mutex::new(once.into()),
            default: Mutex::new(default),
        })
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

struct Handle(Arc<MockFlush>);

impl FlushUnsynced for Handle {
    fn flush_unsynced(&self) -> BoxFuture<'static, Result<bool, TimerError>> {
        self.0.calls.fetch_add(1, Ordering::SeqCst);
        let answer = self
            .0
            .once
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pop_front();
        let default = self
            .0
            .default
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .unwrap_or(false);
        async move {
            match answer {
                Some(Answer::Resolve(v)) => Ok(v),
                Some(Answer::Reject(message)) => Err(TimerError::Store(message.to_owned())),
                Some(Answer::Pending(gate)) => {
                    gate.wait().await;
                    Ok(false)
                }
                None => Ok(default),
            }
        }
        .boxed()
    }
}

struct Rig {
    exec: ManualExecutor,
    timers: FakeTimers,
    flush: Arc<MockFlush>,
    logger: RecLogger,
}

impl Rig {
    fn new(flush: Arc<MockFlush>) -> Self {
        let exec = ManualExecutor::new();
        Self {
            timers: FakeTimers::new(&exec),
            exec,
            flush,
            logger: RecLogger::default(),
        }
    }

    fn drain(&self, is_online: Option<Probe>, interval_ms: Option<f64>) -> Arc<TimerSyncDrain> {
        TimerSyncDrain::new(TimerSyncDrainDeps {
            timer: Box::new(Handle(Arc::clone(&self.flush))),
            is_online,
            interval_ms,
            timers: Arc::new(self.timers.clone()),
            spawner: Arc::new(self.exec.clone()),
            logger: Some(Arc::new(self.logger.clone())),
        })
    }

    fn settle(&self, fut: timo_core::timer::exec::SharedFuture) {
        run_on(&self.exec, fut);
    }
}

type Probe = Box<dyn Fn() -> Option<bool> + Send + Sync>;

fn online() -> Probe {
    Box::new(|| Some(true))
}

mod timer_sync_drain {
    use super::*;

    #[test]
    fn interval_calls_flush_unsynced() {
        let rig = Rig::new(MockFlush::new(vec![], Some(false)));
        let drain = rig.drain(Some(online()), Some(1000.0));

        drain.start();
        rig.timers.advance_by(1000.0);

        assert_eq!(rig.flush.calls(), 1);
        drain.stop();
    }

    #[test]
    fn does_not_run_overlapping_drains() {
        let gate = Gate::default();
        let rig = Rig::new(MockFlush::new(
            vec![Answer::Pending(gate.clone())],
            Some(false),
        ));
        let drain = rig.drain(Some(online()), Some(1000.0));

        let first = drain.drain_now(TimerSyncDrainReason::Manual, 1);
        let second = drain.drain_now(TimerSyncDrainReason::Heartbeat, 1);

        assert_eq!(rig.flush.calls(), 1);
        assert!(first.ptr_eq(&second));
        gate.open();
        rig.settle(first);
    }

    #[test]
    fn skips_scheduled_interval_drains_when_definitely_offline() {
        let rig = Rig::new(MockFlush::new(vec![], Some(false)));
        let drain = rig.drain(Some(Box::new(|| Some(false))), Some(1000.0));

        drain.start();
        rig.timers.advance_by(1000.0);

        assert_eq!(rig.flush.calls(), 0);
        drain.stop();
    }

    #[test]
    fn runs_immediate_drains_when_online_status_is_true() {
        let rig = Rig::new(MockFlush::new(vec![], Some(false)));
        let drain = rig.drain(Some(online()), None);

        let done = drain.drain_now(TimerSyncDrainReason::Auth, 1);
        rig.settle(done);

        assert_eq!(rig.flush.calls(), 1);
    }

    #[test]
    fn runs_immediate_drains_when_online_status_is_unknown() {
        let rig = Rig::new(MockFlush::new(vec![], Some(false)));
        let drain = rig.drain(Some(Box::new(|| None)), None); // the probe throws

        let done = drain.drain_now(TimerSyncDrainReason::Wake, 1);
        rig.settle(done);

        assert_eq!(rig.flush.calls(), 1);
    }

    #[test]
    fn swallows_flush_failures_so_future_retries_can_run() {
        let rig = Rig::new(MockFlush::new(
            vec![Answer::Reject("db busy"), Answer::Resolve(false)],
            Some(false),
        ));
        let drain = rig.drain(Some(online()), None);

        let done = drain.drain_now(TimerSyncDrainReason::Manual, 1);
        rig.settle(done);
        let done = drain.drain_now(TimerSyncDrainReason::Heartbeat, 1);
        rig.settle(done);

        assert_eq!(rig.flush.calls(), 2);
    }

    #[test]
    fn keeps_draining_while_the_backlog_reports_more_work() {
        // flushUnsynced is bounded per call so a long backlog cannot wedge the app.
        // The drain must therefore keep going instead of waiting a whole interval.
        let rig = Rig::new(MockFlush::new(
            vec![
                Answer::Resolve(true),
                Answer::Resolve(true),
                Answer::Resolve(false),
            ],
            Some(false),
        ));
        let drain = rig.drain(Some(online()), Some(60_000.0));

        let done = drain.drain_now(TimerSyncDrainReason::Boot, 1);
        rig.settle(done);
        // The interval is never started here, so this only drives the continuation.
        rig.timers.run_all();

        assert_eq!(rig.flush.calls(), 3);
        drain.stop();
    }

    #[test]
    fn stops_after_a_pass_that_reports_an_empty_backlog() {
        let rig = Rig::new(MockFlush::new(vec![], Some(false)));
        let drain = rig.drain(Some(online()), Some(60_000.0));

        let done = drain.drain_now(TimerSyncDrainReason::Boot, 1);
        rig.settle(done);
        rig.timers.run_all();

        assert_eq!(rig.flush.calls(), 1);
        drain.stop();
    }

    #[test]
    fn gives_up_chaining_when_the_backlog_never_reports_itself_empty() {
        // The field failure: flushUnsynced answered "more remaining" on every pass,
        // so the chain never ended. A backlog that will not clear must decay into
        // the interval, not spin.
        let rig = Rig::new(MockFlush::new(vec![], Some(true)));
        let drain = rig.drain(Some(online()), Some(60_000.0));

        let done = drain.drain_now(TimerSyncDrainReason::Boot, 1);
        rig.settle(done);
        rig.timers.run_all();

        assert_eq!(
            rig.flush.calls(),
            usize::try_from(MAX_CHAINED_DRAIN_PASSES).unwrap()
        );
        let warns = rig.logger.lines("warn");
        assert_eq!(warns.len(), 1);
        assert_eq!(
            warns[0].message,
            "timer sync drain still reports a backlog; leaving it to the interval"
        );
        assert!(warns[0].meta.contains(&(
            "passes".to_owned(),
            LogValue::Number(f64::from(MAX_CHAINED_DRAIN_PASSES))
        )));
        drain.stop();
    }

    #[test]
    fn leaves_the_in_flight_slot_free_once_chaining_stops() {
        // Starving the scheduled drains is what actually lost the time, so assert
        // the slot is reusable rather than just that the chain ended.
        let rig = Rig::new(MockFlush::new(vec![], Some(true)));
        let drain = rig.drain(Some(online()), Some(60_000.0));

        let done = drain.drain_now(TimerSyncDrainReason::Boot, 1);
        rig.settle(done);
        rig.timers.run_all();
        let after_chain = rig.flush.calls();

        let done = drain.drain_now(TimerSyncDrainReason::Heartbeat, 1);
        rig.settle(done);

        assert_eq!(rig.flush.calls(), after_chain + 1);
        drain.stop();
    }
}
