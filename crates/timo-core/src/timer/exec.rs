//! The few runtime services the async parts of the engine need, as traits.
//!
//! `timo-core` has no executor and no timers of its own (no I/O, no clock): the
//! shell injects them, exactly as the TypeScript injects `setInterval` and
//! `clearInterval` into `TimerSyncDrain`. Tests inject a single-threaded
//! executor and a fake clock of timers.

use core::future::Future;
use core::pin::Pin;
use core::task::{Context, Poll, Waker};

use futures_util::future::{BoxFuture, FutureExt, Shared};

/// Runs a future to completion in the background. The future is `'static`, so
/// it owns what it needs. **Contract:** `spawn` must not poll the future before
/// it returns (the engine polls it once itself, with its locks held; see
/// [`spawn_eager`]).
pub trait Spawn: Send + Sync {
    fn spawn(&self, task: BoxFuture<'static, ()>);
}

/// Handle returned by [`Timers::set_interval`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct TimerId(pub u64);

/// `setInterval` / `clearInterval` / `setTimeout`, injectable.
pub trait Timers: Send + Sync {
    fn set_interval(&self, interval_ms: f64, callback: Box<dyn Fn() + Send + Sync>) -> TimerId;
    fn clear_interval(&self, id: TimerId);
    fn set_timeout(&self, delay_ms: f64, callback: Box<dyn FnOnce() + Send>);
}

/// A completion future many callers can await: JavaScript's shared `Promise`.
pub type SharedFuture = Shared<BoxFuture<'static, ()>>;

/// An already-completed [`SharedFuture`]: `Promise.resolve()`.
pub fn completed() -> SharedFuture {
    async {}.boxed().shared()
}

/// One `await` in JavaScript always suspends at least once, even on an already
/// settled promise. This future reproduces that: it is pending once, then ready.
#[derive(Debug, Default)]
pub struct YieldOnce(bool);

/// Suspend once.
#[must_use]
pub const fn yield_once() -> YieldOnce {
    YieldOnce(false)
}

impl Future for YieldOnce {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        if self.0 {
            Poll::Ready(())
        } else {
            self.0 = true;
            cx.waker().wake_by_ref();
            Poll::Pending
        }
    }
}

/// Start `task` the way JavaScript starts an `async` call: run it up to its
/// first suspension *now*, then hand the rest to the spawner. `task` is the
/// completion future callers keep for `Promise.allSettled`.
///
/// The first poll uses a no-op waker; the spawner's own first poll registers the
/// real one, so no wake-up is lost. The task must take no lock before its first
/// suspension (the engine's background syncs only call the `SyncClient` there).
pub fn spawn_eager(spawner: &dyn Spawn, task: &SharedFuture) {
    let mut probe = task.clone();
    let _first = Pin::new(&mut probe).poll(&mut Context::from_waker(Waker::noop()));
    drop(probe);
    spawner.spawn(task.clone().boxed());
}

/// A value in a log record's metadata (`Record<string, unknown>`).
#[derive(Debug, Clone, PartialEq)]
pub enum LogValue {
    Number(f64),
    Bool(bool),
    Text(String),
    Null,
}

/// `{ debug, warn }` of the drain and hydrator's logger.
pub trait EngineLogger: Send + Sync {
    fn debug(&self, message: &str, meta: &[(&str, LogValue)]);
    fn warn(&self, message: &str, meta: &[(&str, LogValue)]);
}
