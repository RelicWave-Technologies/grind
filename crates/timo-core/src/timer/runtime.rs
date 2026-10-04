//! The async driver: the timer service plus its yield points.
//!
//! `TimerRuntime` owns a [`TimerService`] behind a mutex. Every TypeScript
//! `await` is an explicit `.await` here with **no lock held**: the accrual guard
//! (and the clock sampled only after it), the sync round trips, the one tick after
//! every `commit*`, and the wait for background syncs in `flushUnsynced`. Everything
//! between two awaits is one method of `TimerService` under one lock acquisition, which
//! is the TypeScript's atomicity (X4). Nothing is called out to while the lock is held:
//! the mutation listener and the first poll of a background sync (which calls the sync
//! client) run right after the stretch, once the lock is released, so either may call
//! back into the engine. `CONCURRENCY.md` has the row-by-row mapping.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use futures_util::future::{FutureExt, join_all};

use super::error::TimerError;
use super::exec::{SharedFuture, Spawn, spawn_eager, yield_once};
use super::service::{SyncJob, TimerService};
use super::traits::{SyncClient, TrackingAccrualGuard};
use super::types::{StartArgs, TimerAwayReason, TimerExitReason, TimerStatus, TodayLedgerMode};
use crate::types::SegmentKind;

/// `FLUSH_BATCH_LIMIT` of `timerService.ts`.
pub const FLUSH_BATCH_LIMIT: f64 = 25.0;

/// What one stretch left behind.
pub(super) struct Stretch {
    result: Result<(), TimerError>,
    /// The stretch reached `commitOpen`/`commitClosed`, which the TypeScript awaits.
    committed: bool,
}

/// `backgroundSyncs`: the in-flight background syncs.
#[derive(Default)]
struct Background {
    next_id: u64,
    tasks: Vec<(u64, SharedFuture)>,
}

/// The timer service with its guard, its sync client and its spawner.
pub struct TimerRuntime {
    pub(super) svc: Mutex<TimerService>,
    pub(super) guard: Box<dyn TrackingAccrualGuard>,
    pub(super) client: Box<dyn SyncClient>,
    pub(super) spawner: Arc<dyn Spawn>,
    background: Mutex<Background>,
}

impl std::fmt::Debug for TimerRuntime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TimerRuntime").finish_non_exhaustive()
    }
}

impl TimerRuntime {
    /// Wrap a service. The runtime is shared (`Arc`) because background syncs
    /// hold it.
    #[must_use]
    pub fn new(
        service: TimerService,
        guard: Box<dyn TrackingAccrualGuard>,
        client: Box<dyn SyncClient>,
        spawner: Arc<dyn Spawn>,
    ) -> Arc<Self> {
        Arc::new(Self {
            svc: Mutex::new(service),
            guard,
            client,
            spawner,
            background: Mutex::new(Background::default()),
        })
    }

    /// The service, for its synchronous methods (`status`, `recover`, ...). Do
    /// not hold the guard across an `.await`.
    pub fn lock(&self) -> MutexGuard<'_, TimerService> {
        self.svc.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// One atomic stretch of the TypeScript under the service lock; then, with the lock
    /// released, what the stretch queued, in the TypeScript's order: the mutation listener
    /// (`notifyMutation`), then the background syncs (`syncInBackground`).
    pub(super) fn stretch<F>(self: &Arc<Self>, step: F) -> Stretch
    where
        F: FnOnce(&mut TimerService) -> Result<(), TimerError>,
    {
        let (result, committed, listener, jobs) = {
            let mut svc = self.lock();
            let result = step(&mut svc);
            (
                result,
                svc.take_committed(),
                svc.take_notifications(),
                svc.take_outbox(),
            )
        };
        if let Some((listener, count)) = listener {
            for _ in 0..count {
                let _caught = catch_unwind(AssertUnwindSafe(|| listener()));
            }
        }
        for job in jobs {
            self.spawn_background(job);
        }
        Stretch { result, committed }
    }

    /// `await this.commitOpen(...)` / `await this.commitClosed(...)`: one suspension, taken
    /// whether the commit succeeded or threw, and only if the stretch got as far as the commit.
    pub(super) async fn after_commit(stretch: Stretch) -> Result<(), TimerError> {
        if stretch.committed {
            yield_once().await;
        }
        stretch.result
    }

    /// Port of `syncInBackground`: errors swallowed, removed from the set when
    /// settled. Started eagerly, like an `async` call.
    fn spawn_background(self: &Arc<Self>, job: SyncJob) {
        let id = {
            let mut background = self
                .background
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            background.next_id += 1;
            background.next_id
        };
        let this = Arc::clone(self);
        let task = async move {
            let _swallowed = this.try_sync(&job.entry, job.state).await;
            let mut background = this
                .background
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            background.tasks.retain(|(task_id, _)| *task_id != id);
        };
        let shared = task.boxed().shared();
        // Registered before it starts, so a task that settles during its first
        // poll still finds itself in the set to remove.
        self.background
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .tasks
            .push((id, shared.clone()));
        spawn_eager(self.spawner.as_ref(), &shared);
    }

    /// The in-flight background syncs, for `Promise.allSettled`.
    pub(super) fn background_snapshot(&self) -> Vec<SharedFuture> {
        let background = self
            .background
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        background
            .tasks
            .iter()
            .map(|(_, task)| task.clone())
            .collect()
    }

    /// `await Promise.allSettled([...this.backgroundSyncs])`.
    pub(super) async fn settle_background(&self) {
        let pending = self.background_snapshot();
        if !pending.is_empty() {
            join_all(pending).await;
        }
    }

    // --- The public API: one method per `async` method of the TypeScript. ---

    /// `await this.accrualGuard.assertCanAccrue()`: a call of an `async` function, so one
    /// suspension even when it answers at once, and the answer (a refusal too) after it.
    async fn guarded(&self) -> Result<(), TimerError> {
        let answer = self.guard.assert_can_accrue().await;
        yield_once().await;
        Ok(answer?)
    }

    /// `TimerService.start`.
    pub async fn start(self: &Arc<Self>, args: StartArgs) -> Result<TimerStatus, TimerError> {
        self.guarded().await?;
        let stretch = self.stretch(|svc| svc.start_after_guard(&args));
        Self::after_commit(stretch).await?;
        self.status()
    }

    /// `TimerService.stop`.
    pub async fn stop(self: &Arc<Self>) -> Result<TimerStatus, TimerError> {
        Self::after_commit(self.stretch(TimerService::stop_step)).await?;
        self.status()
    }

    /// `TimerService.pause`.
    pub async fn pause(self: &Arc<Self>) -> Result<TimerStatus, TimerError> {
        Self::after_commit(self.stretch(TimerService::pause_step)).await?;
        self.status()
    }

    /// `TimerService.pauseForIdle`.
    pub async fn pause_for_idle(self: &Arc<Self>, idle_for_ms: f64) -> Result<(), TimerError> {
        let stretch = self.stretch(|svc| svc.pause_for_idle_step(idle_for_ms));
        Self::after_commit(stretch).await
    }

    /// `TimerService.pauseForPermission`.
    pub async fn pause_for_permission(
        self: &Arc<Self>,
        unhealthy_for_ms: f64,
    ) -> Result<TimerStatus, TimerError> {
        let stretch = self.stretch(|svc| svc.pause_for_permission_step(unhealthy_for_ms));
        Self::after_commit(stretch).await?;
        self.status()
    }

    /// `TimerService.prepareForQuit`: the exit intent is cleared after the commit's tick.
    pub async fn prepare_for_quit(
        self: &Arc<Self>,
        reason: TimerExitReason,
    ) -> Result<TimerStatus, TimerError> {
        let stretch = self.stretch(|svc| svc.prepare_for_quit_step(reason));
        let committed = stretch.committed;
        Self::after_commit(stretch).await?;
        if committed {
            self.stretch(TimerService::clear_exit_intent_step).result?;
        }
        self.status()
    }

    /// `TimerService.prepareForAway`: no `await`, the close is written directly.
    pub fn prepare_for_away(
        self: &Arc<Self>,
        reason: TimerAwayReason,
        away_for_ms: f64,
    ) -> Result<TimerStatus, TimerError> {
        self.stretch(|svc| svc.prepare_for_away_step(reason, away_for_ms))
            .result?;
        self.status()
    }

    /// `TimerService.acceptServerFinalization`.
    pub fn accept_server_finalization(
        self: &Arc<Self>,
        entry_id: &str,
        ended_at: f64,
    ) -> Result<TimerStatus, TimerError> {
        self.stretch(|svc| svc.accept_server_finalization_step(entry_id, ended_at))
            .result?;
        self.status()
    }

    /// `TimerService.status`.
    pub fn status(&self) -> Result<TimerStatus, TimerError> {
        self.lock().status()
    }

    /// `TimerService.setTodayLedgerMode`.
    pub fn set_today_ledger_mode(&self, mode: TodayLedgerMode) -> bool {
        self.lock().set_today_ledger_mode(mode)
    }

    /// `TimerService.resume`: a no-op when idle or already accruing.
    pub async fn resume(self: &Arc<Self>) -> Result<TimerStatus, TimerError> {
        let at = {
            let svc = self.lock();
            if !svc.resume_needs_guard() {
                drop(svc);
                return self.status();
            }
            svc.clock.now()
        };
        // `await this.resumeFromIdle(...)`: an `async` function's promise, one tick after it settles.
        let resumed = self.resume_from_idle(at).await;
        yield_once().await;
        resumed?;
        self.status()
    }

    /// `TimerService.resumeFromIdle`: open a fresh WORK segment at `at`. The
    /// paused check is before the guard await and not repeated after it.
    pub async fn resume_from_idle(self: &Arc<Self>, at: f64) -> Result<(), TimerError> {
        if !self.lock().resume_needs_guard() {
            return Ok(());
        }
        self.guarded().await?;
        Self::after_commit(self.stretch(|svc| svc.resume_after_guard(at))).await
    }

    /// `TimerService.discardAway`. [dead in production]
    pub async fn discard_away(
        self: &Arc<Self>,
        away_start: f64,
        resume_at: f64,
    ) -> Result<(), TimerError> {
        let Some(started_at) = self.lock().discard_away_needs_guard(away_start, resume_at) else {
            return Ok(());
        };
        self.guarded().await?;
        let stretch =
            self.stretch(|svc| svc.discard_away_after_guard(away_start, resume_at, started_at));
        Self::after_commit(stretch).await
    }

    /// `TimerService.beginMeeting`. [dead in production]
    pub async fn begin_meeting(self: &Arc<Self>, at: f64) -> Result<(), TimerError> {
        self.meeting(SegmentKind::Work, SegmentKind::Meeting, at)
            .await
    }

    /// `TimerService.endMeeting`. [dead in production]
    pub async fn end_meeting(self: &Arc<Self>, at: f64) -> Result<(), TimerError> {
        self.meeting(SegmentKind::Meeting, SegmentKind::Work, at)
            .await
    }

    async fn meeting(
        self: &Arc<Self>,
        from: SegmentKind,
        to: SegmentKind,
        at: f64,
    ) -> Result<(), TimerError> {
        if !self.lock().meeting_needs_guard(from) {
            return Ok(());
        }
        self.guarded().await?;
        Self::after_commit(self.stretch(|svc| svc.meeting_after_guard(to, at))).await
    }
}
