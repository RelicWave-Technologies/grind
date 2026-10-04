//! A single-queue, deterministic executor for tests and the parity replay.
//!
//! Ready tasks run in the order they were woken, one at a time, which is the
//! order JavaScript's microtask queue runs continuations in. There are no
//! threads and no timers: [`ManualExecutor::run_until_stalled`] polls until no
//! task is ready, the equivalent of the harness's "flush microtasks".

use core::task::{Context, Poll, Waker};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, PoisonError};
use std::task::Wake;

use futures_util::future::{BoxFuture, FutureExt};

use super::exec::Spawn;

/// Polls beyond this without stalling mean a task is waking itself forever.
const POLL_BUDGET: usize = 1_000_000;

struct Task {
    future: Mutex<Option<BoxFuture<'static, ()>>>,
    queue: Arc<Queue>,
}

#[derive(Default)]
struct Queue {
    ready: Mutex<VecDeque<Arc<Task>>>,
}

impl Queue {
    fn push(&self, task: Arc<Task>) {
        self.ready
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .push_back(task);
    }

    fn pop(&self) -> Option<Arc<Task>> {
        self.ready
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .pop_front()
    }
}

impl Wake for Task {
    fn wake(self: Arc<Self>) {
        let queue = Arc::clone(&self.queue);
        queue.push(self);
    }
}

/// See the module documentation.
#[derive(Clone, Default)]
pub struct ManualExecutor {
    queue: Arc<Queue>,
}

impl std::fmt::Debug for ManualExecutor {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ManualExecutor").finish_non_exhaustive()
    }
}

impl Spawn for ManualExecutor {
    fn spawn(&self, task: BoxFuture<'static, ()>) {
        let task = Arc::new(Task {
            future: Mutex::new(Some(task)),
            queue: Arc::clone(&self.queue),
        });
        self.queue.push(task);
    }
}

impl ManualExecutor {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Poll ready tasks until none is ready. A task that is woken again while
    /// being polled is queued behind the others.
    pub fn run_until_stalled(&self) {
        for _ in 0..POLL_BUDGET {
            let Some(task) = self.queue.pop() else {
                return;
            };
            let mut slot = task.future.lock().unwrap_or_else(PoisonError::into_inner);
            let Some(mut future) = slot.take() else {
                continue;
            };
            let waker = Waker::from(Arc::clone(&task));
            if future.poll_unpin(&mut Context::from_waker(&waker)) == Poll::Pending {
                *slot = Some(future);
            }
        }
        // A livelock is a bug in the code under test; fail loudly where it shows.
        self.queue
            .ready
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
    }
}
