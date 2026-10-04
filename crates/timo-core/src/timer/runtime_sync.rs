//! The sync round trips: `trySync`, `tryCreateThenSync`, `tryUpdate` and
//! `flushUnsynced`.
//!
//! Each `await` of a network call is an explicit `.await` here with no lock
//! held; the receipt handling between two awaits is one `TimerService` method
//! under one lock acquisition. Every `await` in the TypeScript yields at least
//! once, so [`yield_once`] follows each call, which also keeps a background
//! sync's first poll (see [`super::exec::spawn_eager`]) from reaching the lock.

use std::sync::Arc;

use futures_util::future::{BoxFuture, FutureExt};

use super::error::TimerError;
use super::exec::yield_once;
use super::runtime::{FLUSH_BATCH_LIMIT, TimerRuntime};
use super::types::PendingEntrySyncState;
use crate::js::number::add;
use crate::types::TimeEntry;

impl TimerRuntime {
    /// Port of `TimerService.trySync`.
    pub(super) async fn try_sync(
        self: &Arc<Self>,
        entry: &TimeEntry,
        state: PendingEntrySyncState,
    ) -> Result<(), TimerError> {
        match state {
            PendingEntrySyncState::PendingCreate => {
                self.try_create_then_sync(entry).await;
                Ok(())
            }
            PendingEntrySyncState::PendingUpdate => self.try_update(entry, true).await,
        }
    }

    /// Port of `TimerService.tryCreateThenSync`. Never fails: the TypeScript's
    /// `try` wraps the create call, the acknowledgement and `markEntryCreated`.
    async fn try_create_then_sync(self: &Arc<Self>, entry: &TimeEntry) {
        let request = self.client.create(entry);
        yield_once().await;
        let Ok(receipt) = request.await else {
            return;
        };
        let proceed = self.lock().after_create_receipt(entry, &receipt);
        if !matches!(proceed, Ok(true)) {
            return;
        }
        // Cannot fail with `retry_create_on_not_found` false.
        let _done = self.try_update(entry, false).await;
    }

    /// Port of `TimerService.tryUpdate`. Boxed: it and `try_create_then_sync`
    /// call each other.
    fn try_update<'a>(
        self: &'a Arc<Self>,
        entry: &'a TimeEntry,
        retry_create_on_not_found: bool,
    ) -> BoxFuture<'a, Result<(), TimerError>> {
        async move {
            let request = self.client.sync(entry);
            yield_once().await;
            match request.await {
                Ok(receipt) => {
                    // An acknowledgement failure is caught by the same `try`,
                    // and is not an HttpError, so it is swallowed.
                    let _swallowed = self.lock().acknowledge(entry, &receipt);
                }
                Err(err) if retry_create_on_not_found && err.is_not_found() => {
                    let marked = self.lock().mark_entry_pending_create(entry)?;
                    if marked {
                        self.try_create_then_sync(entry).await;
                    }
                }
                Err(_) => {}
            }
            Ok(())
        }
        .boxed()
    }

    /// Port of `TimerService.flushUnsynced`: push pending entries, oldest first,
    /// at most `limit` per call. `true` only when the limit stopped it with rows
    /// left; a row the server refuses does not count (the interval retries it).
    pub async fn flush_unsynced(self: &Arc<Self>, limit: f64) -> Result<bool, TimerError> {
        self.settle_background().await;
        let rows = self.lock().unsynced()?;
        let mut flushed = 0.0;
        for row in rows {
            if flushed >= limit {
                return Ok(true);
            }
            self.try_sync(&row.entry, row.sync_state).await?;
            flushed = add(flushed, 1.0);
        }
        Ok(false)
    }

    /// `flushUnsynced()` with its default `limit`.
    pub async fn flush_unsynced_default(self: &Arc<Self>) -> Result<bool, TimerError> {
        self.flush_unsynced(FLUSH_BATCH_LIMIT).await
    }
}
